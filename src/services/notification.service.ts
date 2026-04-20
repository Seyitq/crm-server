import { prisma } from '../lib/prisma.js';
import { wsRooms } from '../ws/rooms.js';

interface CreateNotificationParams {
  userId: string;
  type: string;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

export async function createNotification(params: CreateNotificationParams): Promise<void> {
  const notification = await prisma.notification.create({
    data: {
      userId: params.userId,
      type: params.type,
      title: params.title,
      message: params.message,
      relatedEntityType: params.relatedEntityType || null,
      relatedEntityId: params.relatedEntityId || null,
    },
  });

  // Push via WebSocket
  wsRooms.sendToUser(params.userId, {
    event: 'notification:new',
    data: {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      isRead: false,
      relatedEntityType: notification.relatedEntityType,
      relatedEntityId: notification.relatedEntityId,
      createdAt: notification.createdAt.toISOString(),
    },
  });
}

export async function createNotificationForAdmins(
  params: Omit<CreateNotificationParams, 'userId'>
): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true },
  });

  for (const admin of admins) {
    await createNotification({ ...params, userId: admin.id });
  }
}
