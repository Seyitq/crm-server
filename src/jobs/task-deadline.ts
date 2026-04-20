import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { createNotification } from '../services/notification.service.js';

export function startTaskDeadlineJob(): void {
  // Her 15 dakikada bir kontrol et
  cron.schedule('*/15 * * * *', async () => {
    console.log('[JOB] Checking for overdue tasks...');

    try {
      const now = new Date();

      // Süresi dolmuş, tamamlanmamış/iptal edilmemiş görevler
      const overdueTasks = await prisma.task.findMany({
        where: {
          dueDate: { lt: now },
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
        select: {
          id: true,
          title: true,
          dueDate: true,
          assignedTo: true,
          priority: true,
        },
      });

      if (overdueTasks.length === 0) {
        console.log('[JOB] No overdue tasks found.');
        return;
      }

      console.log(`[JOB] Found ${overdueTasks.length} overdue task(s).`);

      for (const task of overdueTasks) {
        // Daha önce bu görev için bildirim gönderilmiş mi?
        const existing = await prisma.notification.findFirst({
          where: {
            relatedEntityType: 'TASK',
            relatedEntityId: task.id,
            type: 'TASK_DEADLINE',
          },
        });

        if (existing) continue; // Zaten bildirim gönderilmiş

        const dueDateStr = task.dueDate
          ? new Date(task.dueDate).toLocaleDateString('tr-TR', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '';

        await createNotification({
          userId: task.assignedTo,
          type: 'TASK_DEADLINE',
          title: 'Görev Süresi Doldu',
          message: `"${task.title}" görevi ${dueDateStr} tarihinde tamamlanması gerekirdi.`,
          relatedEntityType: 'TASK',
          relatedEntityId: task.id,
        });

        console.log(`[JOB] Deadline notification sent for task: ${task.id} → user: ${task.assignedTo}`);
      }
    } catch (err) {
      console.error('[JOB] Task deadline check failed:', err);
    }
  });

  console.log('✅ Task deadline job scheduled (every 15 minutes)');
}
