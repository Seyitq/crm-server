import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { createAuditLog } from '../services/audit.service.js';
import { createNotification } from '../services/notification.service.js';
import { wsRooms } from '../ws/rooms.js';
import { config } from '../config/index.js';

export function startDepositExpiryJob(): void {
  cron.schedule(config.deposit.checkIntervalCron, async () => {
    console.log('[JOB] Checking for expired deposits...');

    try {
      const expiredDeposits = await prisma.deposit.findMany({
        where: {
          status: 'ACTIVE',
          expiresAt: { lt: new Date() },
        },
        include: {
          unit: true,
          customer: { select: { firstName: true, lastName: true } },
          consultant: { select: { id: true, fullName: true } },
        },
      });

      if (expiredDeposits.length === 0) {
        console.log('[JOB] No expired deposits found.');
        return;
      }

      console.log(`[JOB] Found ${expiredDeposits.length} expired deposit(s).`);

      for (const deposit of expiredDeposits) {
        try {
          // Transaction: expire deposit + reset unit
          await prisma.$transaction([
            prisma.deposit.update({
              where: { id: deposit.id },
              data: { status: 'EXPIRED' },
            }),
            prisma.unit.update({
              where: { id: deposit.unitId },
              data: { status: 'AVAILABLE', version: { increment: 1 } },
            }),
          ]);

          // Audit log
          await createAuditLog({
            userId: undefined,
            action: 'DEPOSIT_EXPIRED',
            entityType: 'Deposit',
            entityId: deposit.id,
            beforeState: { status: 'ACTIVE', unitStatus: 'RESERVED' },
            afterState: { status: 'EXPIRED', unitStatus: 'AVAILABLE' },
            description: `Kaparo süresi doldu: ${deposit.unit.code} - ${deposit.customer.firstName} ${deposit.customer.lastName}`,
          });

          // Notify consultant
          await createNotification({
            userId: deposit.consultantId,
            type: 'DEPOSIT_EXPIRY',
            title: 'Kaparo Süresi Doldu',
            message: `${deposit.unit.code} numaralı birime ait kaparonun süresi doldu ve birim tekrar müsait duruma geçti.`,
            relatedEntityType: 'Unit',
            relatedEntityId: deposit.unitId,
          });

          // Broadcast unit status change
          wsRooms.broadcastToAll({
            event: 'unit:statusChanged',
            data: {
              unitCode: deposit.unit.code,
              unitId: deposit.unitId,
              floorId: deposit.unit.floorId,
              blockId: deposit.unit.blockId,
              newStatus: 'AVAILABLE',
            },
          });

          console.log(`[JOB] Deposit expired: ${deposit.unit.code}`);
        } catch (err) {
          console.error(`[JOB] Failed to expire deposit ${deposit.id}:`, err);
        }
      }
    } catch (err) {
      console.error('[JOB] Deposit expiry check failed:', err);
    }
  });

  console.log('✅ Deposit expiry job scheduled (hourly)');
}
