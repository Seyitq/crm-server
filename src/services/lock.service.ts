import { prisma } from '../lib/prisma.js';
import { wsRooms } from '../ws/rooms.js';

export async function acquireLock(unitId: string, userId: string, timeoutMinutes: number = 10): Promise<{ success: boolean; lockedBy?: string }> {
  // Check for existing lock
  const existingLock = await prisma.unitLock.findUnique({
    where: { unitId },
    include: { user: { select: { fullName: true } } },
  });

  if (existingLock) {
    // Check if expired
    if (existingLock.expiresAt < new Date()) {
      // Lock expired, delete and proceed
      await prisma.unitLock.delete({ where: { id: existingLock.id } });
    } else if (existingLock.userId === userId) {
      // Same user, extend the lock
      const newExpiry = new Date(Date.now() + timeoutMinutes * 60 * 1000);
      await prisma.unitLock.update({
        where: { id: existingLock.id },
        data: { expiresAt: newExpiry },
      });
      return { success: true };
    } else {
      // Different user holds the lock
      return { success: false, lockedBy: existingLock.user.fullName };
    }
  }

  // Create new lock
  const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000);
  const lock = await prisma.unitLock.create({
    data: { unitId, userId, expiresAt },
    include: {
      unit: { select: { code: true } },
      user: { select: { fullName: true } },
    },
  });

  // Broadcast lock event
  wsRooms.broadcastToAll({
    event: 'unit:locked',
    data: {
      unitCode: lock.unit.code,
      unitId: lock.unitId,
      lockedBy: lock.userId,
      lockedByName: lock.user.fullName,
      expiresAt: lock.expiresAt.toISOString(),
    },
  });

  return { success: true };
}

export async function releaseLock(unitId: string, userId: string): Promise<boolean> {
  const lock = await prisma.unitLock.findUnique({
    where: { unitId },
    include: { unit: { select: { code: true } } },
  });

  if (!lock) return true;
  if (lock.userId !== userId) return false;

  await prisma.unitLock.delete({ where: { id: lock.id } });

  // Broadcast unlock event
  wsRooms.broadcastToAll({
    event: 'unit:unlocked',
    data: { unitCode: lock.unit.code, unitId: lock.unitId },
  });

  return true;
}

export async function cleanupExpiredLocks(): Promise<number> {
  const expiredLocks = await prisma.unitLock.findMany({
    where: { expiresAt: { lt: new Date() } },
    include: { unit: { select: { code: true } } },
  });

  if (expiredLocks.length === 0) return 0;

  await prisma.unitLock.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  // Broadcast unlock events
  for (const lock of expiredLocks) {
    wsRooms.broadcastToAll({
      event: 'unit:unlocked',
      data: { unitCode: lock.unit.code, unitId: lock.unitId },
    });
  }

  return expiredLocks.length;
}
