import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';

// ---- Validation schemas ----
const createTaskSchema = z.object({
  title:       z.string().min(1).max(200).trim(),
  description: z.string().max(1000).trim().optional(),
  dueDate:     z.string().datetime({ offset: true }).optional(),
  priority:    z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  assignedTo:  z.string().cuid(),
  customerId:  z.string().cuid().optional(),
  notes:       z.string().max(2000).trim().optional(),
});

const updateTaskSchema = z.object({
  title:       z.string().min(1).max(200).trim().optional(),
  description: z.string().max(1000).trim().optional(),
  dueDate:     z.string().datetime({ offset: true }).nullable().optional(),
  priority:    z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  status:      z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  assignedTo:  z.string().cuid().optional(),
  customerId:  z.string().cuid().nullable().optional(),
  notes:       z.string().max(2000).trim().optional(),
});

export const taskRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  // GET /api/tasks — list tasks (filtered by role)
  fastify.get('/', async (request) => {
    const { status, priority, assignedTo, page = '1', limit = '50' } = request.query as any;
    const { user } = request;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Sales consultants only see tasks assigned to them
    const assigneeFilter = user.role === 'ADMIN'
      ? (assignedTo ? assignedTo : undefined)
      : user.userId;

    const where: any = {};
    if (assigneeFilter) where.assignedTo = assigneeFilter;
    if (status)   where.status   = status;
    if (priority) where.priority = priority;

    const [tasks, total] = await Promise.all([
      prisma.task.findMany({
        where,
        include: {
          assignee: { select: { id: true, fullName: true } },
          creator:  { select: { id: true, fullName: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: [
          { status: 'asc' },
          { dueDate: 'asc' },
          { createdAt: 'desc' },
        ],
        skip,
        take: parseInt(limit),
      }),
      prisma.task.count({ where }),
    ]);

    return {
      success: true,
      data: tasks,
      meta: { total, page: parseInt(page), limit: parseInt(limit) },
    };
  });

  // GET /api/tasks/:id — single task
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { user } = request;

    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        assignee: { select: { id: true, fullName: true } },
        creator:  { select: { id: true, fullName: true } },
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      },
    });

    if (!task) {
      return reply.status(404).send({ success: false, error: 'Görev bulunamadı' });
    }

    // Non-admins can only see tasks assigned to or created by them
    if (user.role !== 'ADMIN' && task.assignedTo !== user.userId && task.createdById !== user.userId) {
      return reply.status(403).send({ success: false, error: 'Bu görevi görüntüleme yetkiniz yok' });
    }

    return { success: true, data: task };
  });

  // POST /api/tasks — create task
  fastify.post('/', async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Geçersiz veri', details: parsed.error.flatten() });
    }

    const { title, description, dueDate, priority, assignedTo, customerId, notes } = parsed.data;

    // Verify assignee exists
    const assignee = await prisma.user.findUnique({ where: { id: assignedTo }, select: { id: true, isActive: true } });
    if (!assignee || !assignee.isActive) {
      return reply.status(400).send({ success: false, error: 'Atanan kullanıcı bulunamadı veya aktif değil' });
    }

    // Verify customer if provided
    if (customerId) {
      const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!customer) {
        return reply.status(400).send({ success: false, error: 'Müşteri bulunamadı' });
      }
    }

    const task = await prisma.task.create({
      data: {
        title,
        description,
        dueDate: dueDate ? new Date(dueDate) : null,
        priority,
        assignedTo,
        createdById: request.user.userId,
        customerId: customerId || null,
        notes,
      },
      include: {
        assignee: { select: { id: true, fullName: true } },
        creator:  { select: { id: true, fullName: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return reply.status(201).send({ success: true, data: task });
  });

  // PATCH /api/tasks/:id — update task
  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { user } = request;

    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Geçersiz veri', details: parsed.error.flatten() });
    }

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Görev bulunamadı' });
    }

    // Non-admins can only update tasks assigned to or created by them
    if (user.role !== 'ADMIN' && existing.assignedTo !== user.userId && existing.createdById !== user.userId) {
      return reply.status(403).send({ success: false, error: 'Bu görevi düzenleme yetkiniz yok' });
    }

    const { dueDate, assignedTo, customerId, ...rest } = parsed.data;

    // Verify new assignee if being changed
    if (assignedTo && assignedTo !== existing.assignedTo) {
      const assignee = await prisma.user.findUnique({ where: { id: assignedTo }, select: { id: true, isActive: true } });
      if (!assignee || !assignee.isActive) {
        return reply.status(400).send({ success: false, error: 'Atanan kullanıcı bulunamadı veya aktif değil' });
      }
    }

    const task = await prisma.task.update({
      where: { id },
      data: {
        ...rest,
        ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {}),
        ...(assignedTo ? { assignedTo } : {}),
        ...(customerId !== undefined ? { customerId: customerId || null } : {}),
      },
      include: {
        assignee: { select: { id: true, fullName: true } },
        creator:  { select: { id: true, fullName: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return { success: true, data: task };
  });

  // DELETE /api/tasks/:id — delete task (admin or creator)
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { user } = request;

    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Görev bulunamadı' });
    }

    if (user.role !== 'ADMIN' && existing.createdById !== user.userId) {
      return reply.status(403).send({ success: false, error: 'Bu görevi silme yetkiniz yok' });
    }

    await prisma.task.delete({ where: { id } });
    return { success: true };
  });

  // GET /api/tasks/summary — upcoming/overdue counts for dashboard
  fastify.get('/summary', async (request) => {
    const { user } = request;
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 59, 59, 999);

    const where: any = {
      status: { in: ['PENDING', 'IN_PROGRESS'] },
      ...(user.role !== 'ADMIN' ? { assignedTo: user.userId } : {}),
    };

    const [total, overdue, dueToday] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.count({ where: { ...where, dueDate: { lt: now } } }),
      prisma.task.count({ where: { ...where, dueDate: { gte: now, lte: tomorrow } } }),
    ]);

    return { success: true, data: { total, overdue, dueToday } };
  });
};
