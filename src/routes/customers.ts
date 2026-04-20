import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.js';
import { createAuditLog } from '../services/audit.service.js';

const createCustomerSchema = z.object({
  tcNo: z.string().length(11, 'TC Kimlik No 11 haneli olmalıdır'),
  firstName: z.string().min(1, 'Ad gerekli'),
  lastName: z.string().min(1, 'Soyad gerekli'),
  phone: z.string().min(10, 'Telefon numarası geçersiz'),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
});

const addNoteSchema = z.object({
  content: z.string().min(1, 'Not içeriği gerekli'),
});

const addInteractionSchema = z.object({
  type: z.enum(['MEETING', 'CALL', 'VISIT', 'OTHER']),
  description: z.string().min(1),
  date: z.string().datetime(),
});

export const customerRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);

  // GET /api/customers — list customers
  fastify.get('/', async (request) => {
    const { search, page = '1', pageSize = '20' } = request.query as any;
    const skip = (parseInt(page) - 1) * parseInt(pageSize);
    const take = parseInt(pageSize);

    const where: any = {};
    if (search) {
      where.OR = [
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { tcNo: { contains: search } },
        { phone: { contains: search } },
      ];
    }

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip,
        take,
        include: {
          _count: { select: { deposits: true, sales: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.customer.count({ where }),
    ]);

    return {
      success: true,
      data: customers,
      pagination: {
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(total / take),
      },
    };
  });

  // GET /api/customers/:id — customer detail
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;

    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        notes: {
          include: { user: { select: { fullName: true } } },
          orderBy: { createdAt: 'desc' },
        },
        interactions: {
          include: { user: { select: { fullName: true } } },
          orderBy: { date: 'desc' },
        },
        deposits: {
          include: {
            unit: { select: { code: true } },
            consultant: { select: { fullName: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        sales: {
          include: {
            unit: { select: { code: true } },
            consultant: { select: { fullName: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!customer) {
      return reply.status(404).send({ success: false, error: 'Müşteri bulunamadı' });
    }

    return { success: true, data: customer };
  });

  // GET /api/customers/search/tc/:tcNo — search by TC No
  fastify.get<{ Params: { tcNo: string } }>('/search/tc/:tcNo', async (request, reply) => {
    const { tcNo } = request.params;

    const customer = await prisma.customer.findUnique({ where: { tcNo } });

    if (!customer) {
      return reply.status(404).send({ success: false, error: 'Bu TC No ile müşteri bulunamadı' });
    }

    return { success: true, data: customer };
  });

  // POST /api/customers — create customer
  fastify.post('/', async (request, reply) => {
    const body = createCustomerSchema.parse(request.body);

    // Check for duplicate TC No
    const existing = await prisma.customer.findUnique({ where: { tcNo: body.tcNo } });
    if (existing) {
      return reply.status(409).send({
        success: false,
        error: 'Bu TC Kimlik No ile kayıtlı bir müşteri zaten mevcut',
        data: existing,
      });
    }

    const customer = await prisma.customer.create({
      data: {
        tcNo: body.tcNo,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        email: body.email || null,
        address: body.address || null,
      },
    });

    await createAuditLog({
      userId: request.user.userId,
      action: 'CUSTOMER_CREATED',
      entityType: 'Customer',
      entityId: customer.id,
      afterState: customer,
      description: `Müşteri oluşturuldu: ${customer.firstName} ${customer.lastName}`,
      request,
    });

    return { success: true, data: customer };
  });

  // PUT /api/customers/:id — update customer
  fastify.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    const body = createCustomerSchema.partial().parse(request.body);

    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Müşteri bulunamadı' });
    }

    const customer = await prisma.customer.update({ where: { id }, data: body });

    await createAuditLog({
      userId: request.user.userId,
      action: 'CUSTOMER_UPDATED',
      entityType: 'Customer',
      entityId: customer.id,
      beforeState: existing,
      afterState: customer,
      description: `Müşteri güncellendi: ${customer.firstName} ${customer.lastName}`,
      request,
    });

    return { success: true, data: customer };
  });

  // POST /api/customers/:id/notes — add note
  fastify.post<{ Params: { id: string } }>('/:id/notes', async (request) => {
    const { id } = request.params;
    const body = addNoteSchema.parse(request.body);

    const note = await prisma.customerNote.create({
      data: {
        customerId: id,
        userId: request.user.userId,
        content: body.content,
      },
      include: { user: { select: { fullName: true } } },
    });

    return { success: true, data: note };
  });

  // POST /api/customers/:id/interactions — add interaction
  fastify.post<{ Params: { id: string } }>('/:id/interactions', async (request) => {
    const { id } = request.params;
    const body = addInteractionSchema.parse(request.body);

    const interaction = await prisma.customerInteraction.create({
      data: {
        customerId: id,
        userId: request.user.userId,
        type: body.type,
        description: body.description,
        date: new Date(body.date),
      },
      include: { user: { select: { fullName: true } } },
    });

    return { success: true, data: interaction };
  });
};
