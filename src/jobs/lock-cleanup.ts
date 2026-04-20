import cron from 'node-cron';
import { cleanupExpiredLocks } from '../services/lock.service.js';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { createNotification } from '../services/notification.service.js';

export function startLockCleanupJob(): void {
  cron.schedule(config.lock.cleanupIntervalCron, async () => {
    try {
      const cleaned = await cleanupExpiredLocks();
      if (cleaned > 0) {
        console.log(`[JOB] Cleaned ${cleaned} expired lock(s).`);
      }
    } catch (err) {
      console.error('[JOB] Lock cleanup failed:', err);
    }
  });

  console.log('✅ Lock cleanup job scheduled (every 5 minutes)');
}

export function startOverdueInstallmentCheckJob(): void {
  // Check daily at 09:00
  cron.schedule('0 9 * * *', async () => {
    console.log('[JOB] Checking for overdue installments...');

    try {
      const overdueInstallments = await prisma.installment.findMany({
        where: {
          status: 'PENDING',
          dueDate: { lt: new Date() },
        },
        include: {
          sale: {
            include: {
              unit: { select: { code: true } },
              customer: { select: { firstName: true, lastName: true } },
              consultant: { select: { id: true, fullName: true } },
            },
          },
        },
      });

      // Update status to OVERDUE
      for (const inst of overdueInstallments) {
        await prisma.installment.update({
          where: { id: inst.id },
          data: { status: 'OVERDUE' },
        });

        // Notify consultant
        await createNotification({
          userId: inst.sale.consultantId,
          type: 'OVERDUE_INSTALLMENT',
          title: 'Vadesi Geçen Taksit',
          message: `${inst.sale.unit.code} - ${inst.sale.customer.firstName} ${inst.sale.customer.lastName}: ${Number(inst.amount).toLocaleString('tr-TR')} ₺ tutarındaki taksitin vadesi geçti.`,
          relatedEntityType: 'Installment',
          relatedEntityId: inst.id,
        });
      }

      console.log(`[JOB] Found ${overdueInstallments.length} overdue installment(s).`);
    } catch (err) {
      console.error('[JOB] Overdue installment check failed:', err);
    }
  });

  console.log('✅ Overdue installment check job scheduled (daily at 09:00)');
}
