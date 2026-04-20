import { FastifyPluginAsync } from 'fastify';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { wsRooms } from '../ws/rooms.js';
import { performBackup, decompressBackup, getDiskUsage } from '../services/backup.service.js';
import { config } from '../config/index.js';

export const systemRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/system/backup-now — manual backup (admin only)
  fastify.post('/backup-now', { preHandler: [authenticate, requireAdmin] }, async () => {
    const result = await performBackup();
    return {
      success: result.success,
      data: result.success
        ? { filename: result.filename, message: 'Yedekleme başarıyla tamamlandı.' }
        : { error: result.error, message: 'Yedekleme başarısız oldu.' },
    };
  });

  // GET /api/system/backups — list backup logs (admin only)
  fastify.get('/backups', { preHandler: [authenticate, requireAdmin] }, async (request) => {
    const { page = '1', limit = '20' } = request.query as any;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [backups, total] = await Promise.all([
      prisma.backupLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.backupLog.count(),
    ]);

    return {
      success: true,
      data: backups.map(b => ({
        ...b,
        fileSize: b.fileSize ? Number(b.fileSize) : null,
      })),
      meta: { total, page: parseInt(page), limit: parseInt(limit) },
    };
  });

  // GET /api/system/backups/:id/download — download (decompress) a backup (admin only)
  fastify.get('/backups/:id/download', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const log = await prisma.backupLog.findUnique({ where: { id } });
    if (!log || log.status !== 'success' || !log.filename) {
      return reply.status(404).send({ success: false, error: 'Yedek bulunamadı' });
    }

    const backupDir = config.backup.directory;
    const gzPath = path.join(backupDir, log.filename);
    if (!fs.existsSync(gzPath)) {
      return reply.status(404).send({ success: false, error: 'Yedek dosyası diskte bulunamadı' });
    }

    // Decompress to a temp file then stream it
    const tmpFile = path.join(os.tmpdir(), `crm_restore_${Date.now()}.db`);
    try {
      await decompressBackup(gzPath, tmpFile);
      const stat = fs.statSync(tmpFile);
      const downloadName = log.filename.replace('.gz', '');

      reply
        .header('Content-Disposition', `attachment; filename="${downloadName}"`)
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', stat.size);

      const stream = fs.createReadStream(tmpFile);
      stream.on('close', () => {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      });
      return reply.send(stream);
    } catch (err: any) {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      return reply.status(500).send({ success: false, error: `Decompress hatası: ${err.message}` });
    }
  });

  // POST /api/system/backup-status — internal backup script callback
  fastify.post('/backup-status', async (request) => {
    const { status, filename, error } = request.body as any;

    await prisma.backupLog.create({
      data: { status, filename: filename || null, error: error || null },
    });

    if (status === 'failed') {
      const { createNotificationForAdmins } = await import('../services/notification.service.js');
      await createNotificationForAdmins({
        type: 'BACKUP_FAILURE',
        title: 'Yedekleme Başarısız',
        message: `Veritabanı yedeklemesi başarısız oldu. Hata: ${error || 'Bilinmiyor'}`,
      });
    }

    return { success: true };
  });

  // GET /api/system/status — system status + disk info (admin only)
  fastify.get('/status', { preHandler: [authenticate, requireAdmin] }, async () => {
    const lastBackup = await prisma.backupLog.findFirst({
      where: { status: 'success' },
      orderBy: { createdAt: 'desc' },
    });

    const lastBackupRecord = await prisma.backupLog.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    const onlineUsers = wsRooms.getOnlineUsers();

    const backupOverdue = lastBackup
      ? (Date.now() - lastBackup.createdAt.getTime()) > 7 * 60 * 60 * 1000
      : true;

    // Count backups on disk
    const backupDir = config.backup.directory;
    let backupFilesOnDisk = 0;
    if (fs.existsSync(backupDir)) {
      backupFilesOnDisk = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('crm_backup_') && (f.endsWith('.db.gz') || f.endsWith('.db')))
        .length;
    }

    // Disk usage
    const disk = getDiskUsage(backupDir.length ? backupDir : '.');
    const diskWarning = disk ? disk.usedPercent > config.backup.diskWarningPercent : false;

    return {
      success: true,
      data: {
        lastBackup: lastBackup ? {
          timestamp: lastBackup.createdAt,
          filename: lastBackup.filename,
          checksum: lastBackup.checksum,
          fileSize: lastBackup.fileSize ? Number(lastBackup.fileSize) : null,
        } : null,
        backupOverdue,
        lastBackupStatus: lastBackupRecord?.status || 'unknown',
        backupFilesOnDisk,
        onlineUsers,
        onlineUserCount: onlineUsers.length,
        serverUptime: process.uptime(),
        disk: disk ? {
          totalGB: +(disk.total / 1024 ** 3).toFixed(1),
          freeGB:  +(disk.free  / 1024 ** 3).toFixed(1),
          usedPercent: +disk.usedPercent.toFixed(1),
          warning: diskWarning,
        } : null,
      },
    };
  });
};
