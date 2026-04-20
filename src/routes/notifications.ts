import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  // GET /api/notifications — list notifications for current user
  fastify.get('/', async (request) => {
    const { page = '1', pageSize = '20', unreadOnly = 'false' } = request.query as any;
    const skip = (parseInt(page) - 1) * parseInt(pageSize);
    const take = parseInt(pageSize);

    const where: any = { userId: request.user.userId };
    if (unreadOnly === 'true') {
      where.isRead = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { userId: request.user.userId, isRead: false },
      }),
    ]);

    return {
      success: true,
      data: notifications,
      unreadCount,
      pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / take) },
    };
  });

  // GET /api/notifications/unread-count
  fastify.get('/unread-count', async (request) => {
    const count = await prisma.notification.count({
      where: { userId: request.user.userId, isRead: false },
    });
    return { success: true, data: { count } };
  });

  // PUT /api/notifications/:id/read — mark as read
  fastify.put<{ Params: { id: string } }>('/:id/read', async (request) => {
    const { id } = request.params;

    await prisma.notification.update({
      where: { id, userId: request.user.userId },
      data: { isRead: true },
    });

    return { success: true };
  });

  // PUT /api/notifications/read-all — mark all as read
  fastify.put('/read-all', async (request) => {
    await prisma.notification.updateMany({
      where: { userId: request.user.userId, isRead: false },
      data: { isRead: true },
    });

    return { success: true };
  });

  // GET /api/notifications/all — admin: all system notifications
  fastify.get('/all', async (request, reply) => {
    if (request.user.role !== 'ADMIN') {
      return reply.status(403).send({ success: false, error: 'Yetkiniz yok' });
    }

    const { page = '1', pageSize = '50' } = request.query as any;
    const skip = (parseInt(page) - 1) * parseInt(pageSize);
    const take = parseInt(pageSize);

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        skip,
        take,
        include: { user: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notification.count(),
    ]);

    return {
      success: true,
      data: notifications,
      pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / take) },
    };
  });
};
