import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { createAuditLog } from '../services/audit.service.js';
import { acquireLock, releaseLock } from '../services/lock.service.js';
import { wsRooms } from '../ws/rooms.js';

const createUnitSchema = z.object({
  code: z.string().min(1),
  floorId: z.string().min(1),
  blockId: z.string().min(1),
  type: z.string().optional(),
  area: z.number().positive().optional(),
  price: z.number().positive(),
  notes: z.string().optional(),
  orientation: z.enum(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']).optional(),
});

const bulkCreateUnitSchema = z.object({
  units: z.array(createUnitSchema).min(1),
});

export const unitRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  // GET /api/units/:id — unit detail (supports lookup by id or code)
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    let unit = await prisma.unit.findUnique({
      where: { id },
      include: {
        floor: { select: { number: true, label: true } },
        block: { select: { name: true, projectId: true } },
        deposits: {
          where: { status: 'ACTIVE' },
          include: {
            customer: true,
            consultant: { select: { fullName: true } },
          },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
        sales: {
          include: {
            customer: true,
            consultant: { select: { fullName: true } },
            installments: { orderBy: { order: 'asc' } },
          },
          take: 1,
          orderBy: { createdAt: 'desc' },
        },
        locks: {
          include: { user: { select: { fullName: true } } },
        },
      },
    });

    // Fallback: lookup by code if not found by id
    if (!unit) {
      unit = await prisma.unit.findFirst({
        where: { code: id },
        include: {
          floor: { select: { number: true, label: true } },
          block: { select: { name: true, projectId: true } },
          deposits: {
            where: { status: 'ACTIVE' },
            include: {
              customer: true,
              consultant: { select: { fullName: true } },
            },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
          sales: {
            include: {
              customer: true,
              consultant: { select: { fullName: true } },
              installments: { orderBy: { order: 'asc' } },
            },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
          locks: {
            include: { user: { select: { fullName: true } } },
          },
        },
      });
    }

    if (!unit) {
      return reply.status(404).send({ success: false, error: 'Birim bulunamadı' });
    }

    const activeLock = unit.locks.find(l => l.expiresAt > new Date());

    return {
      success: true,
      data: {
        id: unit.id,
        code: unit.code,
        floorId: unit.floorId,
        blockId: unit.blockId,
        type: unit.type,
        area: unit.area?.toString(),
        price: unit.price.toString(),
        status: unit.status,
        version: unit.version,
        notes: unit.notes,
        floor: unit.floor,
        block: unit.block,
        activeDeposit: unit.deposits[0] || null,
        activeSale: unit.sales[0] || null,
        lockInfo: activeLock ? {
          unitId: unit.id,
          userId: activeLock.userId,
          lockedBy: activeLock.user.fullName,
          expiresAt: activeLock.expiresAt.toISOString(),
        } : null,
      },
    };
  });

  // POST /api/units — create unit (admin only)
  fastify.post('/', { preHandler: [requireAdmin] }, async (request) => {
    const body = createUnitSchema.parse(request.body);

    const unit = await prisma.unit.create({
      data: {
        code: body.code,
        floorId: body.floorId,
        blockId: body.blockId,
        type: body.type,
        area: body.area,
        price: body.price,
        notes: body.notes,
        orientation: body.orientation,
      },
    });

    await createAuditLog({
      userId: request.user.userId,
      action: 'UNIT_CREATED',
      entityType: 'Unit',
      entityId: unit.id,
      afterState: unit,
      description: `Birim oluşturuldu: ${unit.code}`,
      request,
    });

    return { success: true, data: unit };
  });

  // POST /api/units/bulk — bulk create units (admin only)
  fastify.post('/bulk', { preHandler: [requireAdmin] }, async (request) => {
    const { units } = bulkCreateUnitSchema.parse(request.body);

    const created = await prisma.unit.createMany({
      data: units.map(u => ({
        code: u.code,
        floorId: u.floorId,
        blockId: u.blockId,
        type: u.type,
        area: u.area,
        price: u.price,
        notes: u.notes,
      })),
    });

    return { success: true, data: { count: created.count } };
  });

  // PUT /api/units/:id — update unit (admin only)
  fastify.put<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const body = createUnitSchema.partial().parse(request.body);

    const existing = await prisma.unit.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Birim bulunamadı' });
    }

    const unit = await prisma.unit.update({ where: { id }, data: body });

    await createAuditLog({
      userId: request.user.userId,
      action: 'UNIT_UPDATED',
      entityType: 'Unit',
      entityId: unit.id,
      beforeState: existing,
      afterState: unit,
      description: `Birim güncellendi: ${unit.code}`,
      request,
    });

    return { success: true, data: unit };
  });

  // POST /api/units/:id/lock — acquire lock
  fastify.post<{ Params: { id: string } }>('/:id/lock', async (request, reply) => {
    const { id } = request.params;
    const result = await acquireLock(id, request.user.userId);

    if (!result.success) {
      return reply.status(409).send({
        success: false,
        error: `Bu birim şu anda ${result.lockedBy} tarafından işlem görmektedir. Lütfen daha sonra tekrar deneyin.`,
      });
    }

    return { success: true };
  });

  // DELETE /api/units/:id/lock — release lock
  fastify.delete<{ Params: { id: string } }>('/:id/lock', async (request, reply) => {
    const { id } = request.params;
    const released = await releaseLock(id, request.user.userId);

    if (!released) {
      return reply.status(403).send({ success: false, error: 'Bu kilidi kaldırma yetkiniz yok' });
    }

    return { success: true };
  });

  // DELETE /api/units/:id — delete unit (admin only)
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params;

    const unit = await prisma.unit.findUnique({
      where: { id },
      include: {
        sales: { select: { id: true }, take: 1 },
        deposits: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 },
      },
    });

    if (!unit) {
      return reply.status(404).send({ success: false, error: 'Birim bulunamadı' });
    }

    if (unit.status === 'SOLD' || unit.sales.length > 0) {
      return reply.status(400).send({ success: false, error: 'Satılmış birim silinemez' });
    }

    if (unit.status === 'RESERVED' || unit.deposits.length > 0) {
      return reply.status(400).send({ success: false, error: 'Aktif kaparası olan birim silinemez' });
    }

    await prisma.unit.delete({ where: { id } });

    await createAuditLog({
      userId: request.user.userId,
      action: 'UNIT_DELETED',
      entityType: 'Unit',
      entityId: id,
      beforeState: unit,
      description: `Birim silindi: ${unit.code}`,
      request,
    });

    return { success: true };
  });
};
