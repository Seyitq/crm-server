import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { createAuditLog } from '../services/audit.service.js';
import { wsRooms } from '../ws/rooms.js';

const installmentItemSchema = z.object({
  amount: z.number().positive(),
  dueDate: z.string().datetime(),
  order: z.number().int().positive(),
});

const createSaleSchema = z.object({
  unitId: z.string().min(1),
  customerId: z.string().min(1),
  totalPrice: z.number().positive(),
  paymentType: z.enum(['CASH', 'BANK_LOAN', 'INSTALLMENT', 'MIXED']),
  bankName: z.string().optional(),
  loanAmount: z.number().positive().optional(),
  approvalDate: z.string().datetime().optional(),
  notes: z.string().optional(),
  installments: z.array(installmentItemSchema).optional(),
  installmentCount: z.number().int().positive().optional(), // Auto-generate from count
  depositId: z.string().optional(), // Link to existing deposit
  depositAmount: z.number().nonnegative().optional(), // MIXED: upfront payment portion
});

const payInstallmentSchema = z.object({
  paidAmount: z.number().positive(),
  paidDate: z.string().datetime().optional(),
});

export const saleRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  // GET /api/sales — list sales
  fastify.get('/', async (request) => {
    const { page = '1', pageSize = '20' } = request.query as any;
    const skip = (parseInt(page) - 1) * parseInt(pageSize);
    const take = parseInt(pageSize);

    const where: any = {};
    if (request.user.role === 'SALES_CONSULTANT') {
      where.consultantId = request.user.userId;
    }

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        skip,
        take,
        include: {
          unit: { select: { code: true } },
          customer: { select: { firstName: true, lastName: true, phone: true } },
          consultant: { select: { fullName: true } },
          installments: { orderBy: { order: 'asc' } },
        },
        orderBy: { saleDate: 'desc' },
      }),
      prisma.sale.count({ where }),
    ]);

    return {
      success: true,
      data: sales,
      pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / take) },
    };
  });

  // GET /api/sales/:id — sale detail
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    const sale = await prisma.sale.findUnique({
      where: { id },
      include: {
        unit: { select: { code: true, type: true, area: true, blockId: true, floorId: true } },
        customer: true,
        consultant: { select: { fullName: true } },
        installments: { orderBy: { order: 'asc' } },
        contracts: {
          include: { template: { select: { name: true } } },
          orderBy: { generatedAt: 'desc' },
        },
      },
    });

    if (!sale) {
      return reply.status(404).send({ success: false, error: 'Satış bulunamadı' });
    }

    return { success: true, data: sale };
  });

  // POST /api/sales — create sale
  fastify.post('/', async (request, reply) => {
    const body = createSaleSchema.parse(request.body);

    // Check unit (by id or code)
    let unit = await prisma.unit.findUnique({ where: { id: body.unitId } });
    if (!unit) {
      unit = await prisma.unit.findFirst({ where: { code: body.unitId } });
    }
    if (!unit) {
      return reply.status(404).send({ success: false, error: 'Birim bulunamadı' });
    }
    if (unit.status === 'SOLD') {
      return reply.status(409).send({ success: false, error: 'Bu birim zaten satılmış' });
    }

    // Transaction
    const sale = await prisma.$transaction(async (tx) => {
      // If deposit exists, convert it
      if (body.depositId) {
        await tx.deposit.update({
          where: { id: body.depositId },
          data: { status: 'CONVERTED' },
        });
      }

      // Create sale
      const newSale = await tx.sale.create({
        data: {
          unitId: unit.id,
          customerId: body.customerId,
          consultantId: request.user.userId,
          totalPrice: body.totalPrice,
          paymentType: body.paymentType,
          bankName: body.bankName || null,
          loanAmount: body.loanAmount || null,
          approvalDate: body.approvalDate ? new Date(body.approvalDate) : null,
          notes: body.notes || null,
        },
      });

      // Create installments if applicable
      if (body.paymentType === 'INSTALLMENT' || body.paymentType === 'MIXED') {
        // For MIXED: base amount is totalPrice minus the upfront depositAmount
        const baseAmount =
          body.paymentType === 'MIXED'
            ? body.totalPrice - (body.depositAmount ?? 0)
            : body.totalPrice;

        if (body.paymentType === 'INSTALLMENT' && body.installments?.length) {
          // Use explicitly provided installments (only for INSTALLMENT)
          await tx.installment.createMany({
            data: body.installments.map(inst => ({
              saleId: newSale.id,
              amount: inst.amount,
              dueDate: new Date(inst.dueDate),
              order: inst.order,
            })),
          });
        } else if (body.installmentCount) {
          // Auto-generate equal installments from baseAmount
          const count = body.installmentCount;
          const instAmount = Math.round((baseAmount / count) * 100) / 100;
          const installmentData = [];
          for (let i = 1; i <= count; i++) {
            const dueDate = new Date();
            dueDate.setMonth(dueDate.getMonth() + i);
            installmentData.push({
              saleId: newSale.id,
              amount: i === count ? Math.round((baseAmount - instAmount * (count - 1)) * 100) / 100 : instAmount,
              dueDate,
              order: i,
            });
          }
          await tx.installment.createMany({ data: installmentData });
        }
      }

      // Update unit status
      await tx.unit.update({
        where: { id: unit.id, version: unit.version },
        data: { status: 'SOLD', version: { increment: 1 } },
      });

      return newSale;
    });

    const fullSale = await prisma.sale.findUnique({
      where: { id: sale.id },
      include: {
        unit: { select: { code: true } },
        customer: { select: { firstName: true, lastName: true } },
        consultant: { select: { fullName: true } },
        installments: { orderBy: { order: 'asc' } },
      },
    });

    await createAuditLog({
      userId: request.user.userId,
      action: 'SALE_CREATED',
      entityType: 'Sale',
      entityId: sale.id,
      afterState: fullSale,
      description: `Satış oluşturuldu: ${unit.code} - ${fullSale?.customer.firstName} ${fullSale?.customer.lastName}`,
      request,
    });

    // Broadcast
    wsRooms.broadcastToAll({
      event: 'unit:statusChanged',
      data: {
        unitCode: unit.code,
        unitId: unit.id,
        floorId: unit.floorId,
        blockId: unit.blockId,
        newStatus: 'SOLD',
      },
    });

    return { success: true, data: fullSale };
  });

  // PUT /api/sales/:saleId/installments/:installmentId/pay — pay installment
  fastify.put<{ Params: { saleId: string; installmentId: string } }>(
    '/:saleId/installments/:installmentId/pay',
    async (request, reply) => {
      const { installmentId } = request.params;
      const body = payInstallmentSchema.parse(request.body);

      const installment = await prisma.installment.findUnique({ where: { id: installmentId } });
      if (!installment) {
        return reply.status(404).send({ success: false, error: 'Taksit bulunamadı' });
      }
      if (installment.status === 'PAID') {
        return reply.status(409).send({ success: false, error: 'Bu taksit zaten ödenmiş' });
      }

      const updated = await prisma.installment.update({
        where: { id: installmentId },
        data: {
          paidAmount: body.paidAmount,
          paidDate: body.paidDate ? new Date(body.paidDate) : new Date(),
          status: 'PAID',
        },
      });

      await createAuditLog({
        userId: request.user.userId,
        action: 'INSTALLMENT_PAID',
        entityType: 'Installment',
        entityId: installmentId,
        beforeState: installment,
        afterState: updated,
        description: `Taksit ödendi: ${body.paidAmount} ₺`,
        request,
      });

      return { success: true, data: updated };
    }
  );

  // GET /api/sales/overdue — get overdue installments
  fastify.get('/overdue/installments', async (request) => {
    const where: any = {
      status: 'PENDING',
      dueDate: { lt: new Date() },
    };

    if (request.user.role === 'SALES_CONSULTANT') {
      where.sale = { consultantId: request.user.userId };
    }

    const overdue = await prisma.installment.findMany({
      where,
      include: {
        sale: {
          include: {
            unit: { select: { code: true } },
            customer: { select: { firstName: true, lastName: true, phone: true } },
            consultant: { select: { fullName: true } },
          },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    return { success: true, data: overdue };
  });
};
