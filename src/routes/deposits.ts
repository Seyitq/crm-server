import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { createAuditLog } from '../services/audit.service.js';
import { createNotification } from '../services/notification.service.js';
import { wsRooms } from '../ws/rooms.js';

const createDepositSchema = z.object({
  unitId: z.string().min(1),
  customerId: z.string().min(1),
  amount: z.number().positive(),
  validityDays: z.number().int().positive(),
  notes: z.string().optional(),
});

export const depositRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  // GET /api/deposits — list deposits
  fastify.get('/', async (request) => {
    const { status, page = '1', pageSize = '20' } = request.query as any;
    const skip = (parseInt(page) - 1) * parseInt(pageSize);
    const take = parseInt(pageSize);

    const where: any = {};
    if (status) where.status = status;

    // Consultants see only their own deposits
    if (request.user.role === 'SALES_CONSULTANT') {
      where.consultantId = request.user.userId;
    }

    const [deposits, total] = await Promise.all([
      prisma.deposit.findMany({
        where,
        skip,
        take,
        include: {
          unit: { select: { id: true, code: true } },
          customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
          consultant: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.deposit.count({ where }),
    ]);

    return {
      success: true,
      data: deposits,
      pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / take) },
    };
  });

  // POST /api/deposits — create deposit (reserve a unit)
  fastify.post('/', async (request, reply) => {
    const body = createDepositSchema.parse(request.body);

    // Check unit availability with optimistic lock (by id or code)
    let unit = await prisma.unit.findUnique({ where: { id: body.unitId } });
    if (!unit) {
      unit = await prisma.unit.findFirst({ where: { code: body.unitId } });
    }
    if (!unit) {
      return reply.status(404).send({ success: false, error: 'Birim bulunamadı' });
    }
    if (unit.status !== 'AVAILABLE') {
      return reply.status(409).send({ success: false, error: 'Bu birim müsait değil' });
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + body.validityDays);

    // Transaction: create deposit + update unit status
    const [deposit] = await prisma.$transaction([
      prisma.deposit.create({
        data: {
          unitId: unit.id,
          customerId: body.customerId,
          consultantId: request.user.userId,
          amount: body.amount,
          validityDays: body.validityDays,
          expiresAt,
          notes: body.notes || null,
        },
        include: {
          unit: { select: { code: true } },
          customer: { select: { firstName: true, lastName: true } },
        },
      }),
      prisma.unit.update({
        where: { id: unit.id, version: unit.version },
        data: { status: 'RESERVED', version: { increment: 1 } },
      }),
    ]);

    await createAuditLog({
      userId: request.user.userId,
      action: 'DEPOSIT_CREATED',
      entityType: 'Deposit',
      entityId: deposit.id,
      afterState: deposit,
      description: `Kaparo alındı: ${deposit.unit.code} - ${deposit.customer.firstName} ${deposit.customer.lastName}`,
      request,
    });

    // Broadcast unit status change
    wsRooms.broadcastToAll({
      event: 'unit:statusChanged',
      data: {
        unitCode: unit.code,
        unitId: unit.id,
        floorId: unit.floorId,
        blockId: unit.blockId,
        newStatus: 'RESERVED',
      },
    });

    return { success: true, data: deposit };
  });

  // PUT /api/deposits/:id/extend — extend deposit validity (admin)
  fastify.put<{ Params: { id: string } }>('/:id/extend', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const { additionalDays } = z.object({ additionalDays: z.number().int().positive() }).parse(request.body);

    const deposit = await prisma.deposit.findUnique({ where: { id } });
    if (!deposit || deposit.status !== 'ACTIVE') {
      return reply.status(404).send({ success: false, error: 'Aktif kaparo bulunamadı' });
    }

    const newExpiry = new Date(deposit.expiresAt);
    newExpiry.setDate(newExpiry.getDate() + additionalDays);

    const updated = await prisma.deposit.update({
      where: { id },
      data: {
        expiresAt: newExpiry,
        validityDays: deposit.validityDays + additionalDays,
      },
    });

    await createAuditLog({
      userId: request.user.userId,
      action: 'DEPOSIT_EXTENDED',
      entityType: 'Deposit',
      entityId: deposit.id,
      beforeState: deposit,
      afterState: updated,
      description: `Kaparo süresi ${additionalDays} gün uzatıldı`,
      request,
    });

    return { success: true, data: updated };
  });

  // PUT /api/deposits/:id/cancel — cancel deposit (admin)
  fastify.put<{ Params: { id: string } }>('/:id/cancel', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params;

    const deposit = await prisma.deposit.findUnique({
      where: { id },
      include: { unit: true },
    });
    if (!deposit || deposit.status !== 'ACTIVE') {
      return reply.status(404).send({ success: false, error: 'Aktif kaparo bulunamadı' });
    }

    await prisma.$transaction([
      prisma.deposit.update({
        where: { id },
        data: { status: 'CANCELLED' },
      }),
      prisma.unit.update({
        where: { id: deposit.unitId },
        data: { status: 'AVAILABLE', version: { increment: 1 } },
      }),
    ]);

    await createAuditLog({
      userId: request.user.userId,
      action: 'DEPOSIT_CANCELLED',
      entityType: 'Deposit',
      entityId: deposit.id,
      beforeState: deposit,
      description: `Kaparo iptal edildi: ${deposit.unit.code}`,
      request,
    });

    // Broadcast
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

    return { success: true };
  });
};
