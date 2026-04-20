import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { createNotificationForAdmins } from '../services/notification.service.js';
import { performBackup } from '../services/backup.service.js';

export function startBackupCheckJob(): void {
  // Perform actual backup every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    console.log('[JOB] Starting scheduled backup...');
    await performBackup();
  });

  // Check every hour if backup is overdue
  cron.schedule('30 * * * *', async () => {
    console.log('[JOB] Checking backup status...');

    try {
      const lastSuccessfulBackup = await prisma.backupLog.findFirst({
        where: { status: 'success' },
        orderBy: { createdAt: 'desc' },
      });

      if (!lastSuccessfulBackup) {
        console.warn('[JOB] No successful backup found, triggering one now...');
        await performBackup();
        return;
      }

      const hoursSinceBackup = (Date.now() - lastSuccessfulBackup.createdAt.getTime()) / (1000 * 60 * 60);

      if (hoursSinceBackup > 7) {
        console.warn(`[JOB] Backup overdue! Last successful backup was ${hoursSinceBackup.toFixed(1)} hours ago.`);
        await createNotificationForAdmins({
          type: 'BACKUP_FAILURE',
          title: 'Yedekleme Gecikti',
          message: `Son başarılı yedekleme ${hoursSinceBackup.toFixed(1)} saat önce yapıldı. Lütfen yedekleme sistemini kontrol edin.`,
        });
      } else {
        console.log(`[JOB] Backup OK. Last backup ${hoursSinceBackup.toFixed(1)} hours ago.`);
      }
    } catch (err) {
      console.error('[JOB] Backup check failed:', err);
    }
  });

  console.log('✅ Backup job scheduled (every 6 hours) + check (every hour at :30)');
}
