import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { createNotificationForAdmins } from './notification.service.js';

/** Computes SHA-256 hex digest of a file. */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Compresses src → dest.gz using gzip streaming. */
async function compressFile(src: string, dest: string): Promise<void> {
  const readable = fs.createReadStream(src);
  const writable = fs.createWriteStream(dest);
  const gzip = zlib.createGzip({ level: 6 });
  await pipeline(readable, gzip, writable);
}

/** Decompresses src.gz → dest. */
export async function decompressBackup(src: string, dest: string): Promise<void> {
  const readable = fs.createReadStream(src);
  const writable = fs.createWriteStream(dest);
  const gunzip = zlib.createGunzip();
  await pipeline(readable, gunzip, writable);
}

/** Returns disk usage info for the given directory path. */
export function getDiskUsage(dirPath: string): { total: number; free: number; used: number; usedPercent: number } | null {
  try {
    const stats = fs.statfsSync(dirPath);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    const usedPercent = total > 0 ? (used / total) * 100 : 0;
    return { total, free, used, usedPercent };
  } catch {
    return null;
  }
}

/**
 * SQLite backup: VACUUM INTO → SHA-256 → gzip → log → cleanup.
 */
export async function performBackup(): Promise<{ success: boolean; filename?: string; error?: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawFilename = `crm_backup_${timestamp}.db`;
  const gzFilename  = `${rawFilename}.gz`;
  const backupDir   = config.backup.directory;
  const rawPath     = path.join(backupDir, rawFilename);
  const gzPath      = path.join(backupDir, gzFilename);

  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const dbUrl = process.env.DATABASE_URL || 'file:./dev.db';
    const prismaDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
      '../../prisma',
    );
    const normalizedPrismaDir = process.platform === 'win32' && prismaDir.startsWith('/') ? prismaDir.substring(1) : prismaDir;
    const dbFile = path.join(
      normalizedPrismaDir,
      dbUrl.startsWith('file:') ? dbUrl.replace('file:', '') : 'dev.db',
    );

    if (!fs.existsSync(dbFile)) {
      throw new Error(`Veritabanı dosyası bulunamadı: ${dbFile}`);
    }

    // Step 1: create raw .db backup
    try {
      await prisma.$executeRawUnsafe(`VACUUM INTO '${rawPath.replace(/\\/g, '/')}'`);
    } catch {
      fs.copyFileSync(dbFile, rawPath);
    }

    if (!fs.existsSync(rawPath)) {
      throw new Error('Ham yedek dosyası oluşturulamadı');
    }

    // Step 2: compute SHA-256 of the raw file (before compression)
    const checksum = computeFileHash(rawPath);

    // Step 3: compress → .db.gz
    await compressFile(rawPath, gzPath);

    // Step 4: remove raw file (keep only compressed)
    fs.unlinkSync(rawPath);

    if (!fs.existsSync(gzPath)) {
      throw new Error('Sıkıştırılmış yedek dosyası oluşturulamadı');
    }

    const stats = fs.statSync(gzPath);

    // Step 5: log success
    await prisma.backupLog.create({
      data: {
        status: 'success',
        filename: gzFilename,
        fileSize: BigInt(stats.size),
        checksum,
      },
    });

    // Step 6: disk usage warning
    const disk = getDiskUsage(backupDir);
    if (disk && disk.usedPercent > config.backup.diskWarningPercent) {
      await createNotificationForAdmins({
        type: 'SYSTEM',
        title: 'Disk Doluluk Uyarısı',
        message: `Disk kullanımı %${disk.usedPercent.toFixed(1)} seviyesine ulaştı. Eski yedekleri temizlemeyi düşünün.`,
      });
    }

    await cleanupOldBackups();

    console.log(`[BACKUP] Başarılı: ${gzFilename} (${(stats.size / 1024 / 1024).toFixed(2)} MB) sha256:${checksum.substring(0, 8)}…`);
    return { success: true, filename: gzFilename };
  } catch (err: any) {
    // cleanup partial files
    for (const p of [rawPath, gzPath]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }

    const errorMsg = err.message || 'Bilinmeyen hata';

    await prisma.backupLog.create({
      data: { status: 'failed', filename: null, error: errorMsg },
    });

    await createNotificationForAdmins({
      type: 'BACKUP_FAILURE',
      title: 'Yedekleme Başarısız',
      message: `Veritabanı yedeklemesi başarısız oldu. Hata: ${errorMsg}`,
    });

    console.error(`[BACKUP] Başarısız: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

async function cleanupOldBackups(): Promise<void> {
  const backupDir = config.backup.directory;
  if (!fs.existsSync(backupDir)) return;

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('crm_backup_') && (f.endsWith('.db.gz') || f.endsWith('.db')))
    .sort(); // ascending → oldest first

  if (files.length > config.backup.maxBackups) {
    const toDelete = files.slice(0, config.backup.deleteCount);
    for (const file of toDelete) {
      try {
        fs.unlinkSync(path.join(backupDir, file));
        console.log(`[BACKUP] Eski yedek silindi: ${file}`);
      } catch { /* ignore */ }
    }
    console.log(`[BACKUP] Temizlik: ${toDelete.length} eski yedek silindi, ${files.length - toDelete.length} yedek kaldı.`);
  }
}
