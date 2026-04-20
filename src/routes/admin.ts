import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { hashPassword } from '../utils/password.js';
import { createAuditLog } from '../services/audit.service.js';

const createUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  fullName: z.string().min(1),
  role: z.enum(['ADMIN', 'SALES_CONSULTANT']),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

const updateUserSchema = z.object({
  fullName: z.string().min(1).optional(),
  role: z.enum(['ADMIN', 'SALES_CONSULTANT']).optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  isActive: z.boolean().optional(),
});

const assignProjectSchema = z.object({
  projectIds: z.array(z.string()),
});

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string().min(1),
  projectId: z.string().optional(),
});

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireAdmin);

  // ==================== USER MANAGEMENT ====================

  // GET /api/admin/users
  fastify.get('/users', async () => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        phone: true,
        email: true,
        isActive: true,
        createdAt: true,
        projectAssignments: {
          select: { project: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, data: users };
  });

  // POST /api/admin/users
  fastify.post('/users', async (request, reply) => {
    const body = createUserSchema.parse(request.body);

    const existing = await prisma.user.findUnique({ where: { username: body.username } });
    if (existing) {
      return reply.status(409).send({ success: false, error: 'Bu kullanıcı adı zaten mevcut' });
    }

    const passwordHash = await hashPassword(body.password);
    const user = await prisma.user.create({
      data: {
        username: body.username,
        passwordHash,
        fullName: body.fullName,
        role: body.role,
        phone: body.phone || null,
        email: body.email || null,
      },
    });

    await createAuditLog({
      userId: request.user.userId,
      action: 'USER_CREATED',
      entityType: 'User',
      entityId: user.id,
      afterState: { id: user.id, username: user.username, fullName: user.fullName, role: user.role },
      description: `Kullanıcı oluşturuldu: ${user.fullName} (${user.role})`,
      request,
    });

    return {
      success: true,
      data: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
      },
    };
  });

  // PUT /api/admin/users/:id
  fastify.put<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const { id } = request.params;
    const body = updateUserSchema.parse(request.body);

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    const user = await prisma.user.update({ where: { id }, data: body });

    await createAuditLog({
      userId: request.user.userId,
      action: 'USER_UPDATED',
      entityType: 'User',
      entityId: user.id,
      beforeState: existing,
      afterState: user,
      description: `Kullanıcı güncellendi: ${user.fullName}`,
      request,
    });

    return { success: true, data: user };
  });

  // PUT /api/admin/users/:id/reset-password
  fastify.put<{ Params: { id: string } }>('/users/:id/reset-password', async (request, reply) => {
    const { id } = request.params;
    const { newPassword } = z.object({ newPassword: z.string().min(6) }).parse(request.body);

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return reply.status(404).send({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id }, data: { passwordHash } });

    // Invalidate all refresh tokens
    await prisma.refreshToken.deleteMany({ where: { userId: id } });

    await createAuditLog({
      userId: request.user.userId,
      action: 'USER_PASSWORD_RESET',
      entityType: 'User',
      entityId: id,
      description: `Kullanıcı şifresi sıfırlandı: ${user.fullName}`,
      request,
    });

    return { success: true };
  });

  // PUT /api/admin/users/:id/assign-projects
  fastify.put<{ Params: { id: string } }>('/users/:id/assign-projects', async (request) => {
    const { id } = request.params;
    const { projectIds } = assignProjectSchema.parse(request.body);

    // Remove all existing assignments
    await prisma.userProject.deleteMany({ where: { userId: id } });

    // Create new assignments
    if (projectIds.length > 0) {
      await prisma.userProject.createMany({
        data: projectIds.map(projectId => ({ userId: id, projectId })),
      });
    }

    await createAuditLog({
      userId: request.user.userId,
      action: 'USER_PROJECTS_ASSIGNED',
      entityType: 'User',
      entityId: id,
      afterState: { projectIds },
      description: `Kullanıcıya ${projectIds.length} proje atandı`,
      request,
    });

    return { success: true };
  });

  // ==================== TEMPLATE MANAGEMENT ====================

  // GET /api/admin/templates
  fastify.get('/templates', async () => {
    const templates = await prisma.contractTemplate.findMany({
      include: { project: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
    return { success: true, data: templates };
  });

  // POST /api/admin/templates
  fastify.post('/templates', async (request) => {
    const body = templateSchema.parse(request.body);

    const template = await prisma.contractTemplate.create({
      data: {
        name: body.name,
        description: body.description || null,
        content: body.content,
        projectId: body.projectId || null,
      },
    });

    return { success: true, data: template };
  });

  // PUT /api/admin/templates/:id
  fastify.put<{ Params: { id: string } }>('/templates/:id', async (request, reply) => {
    const { id } = request.params;
    const body = templateSchema.partial().parse(request.body);

    const template = await prisma.contractTemplate.findUnique({ where: { id } });
    if (!template) {
      return reply.status(404).send({ success: false, error: 'Şablon bulunamadı' });
    }

    const updated = await prisma.contractTemplate.update({ where: { id }, data: body });
    return { success: true, data: updated };
  });

  // DELETE /api/admin/templates/:id (soft delete)
  fastify.delete<{ Params: { id: string } }>('/templates/:id', async (request, reply) => {
    const { id } = request.params;

    await prisma.contractTemplate.update({
      where: { id },
      data: { isActive: false },
    });

    return { success: true };
  });

  // ==================== AUDIT LOGS ====================

  // GET /api/admin/audit-logs
  fastify.get('/audit-logs', async (request) => {
    const { page = '1', pageSize = '50', action, entityType, userId } = request.query as any;
    const skip = (parseInt(page) - 1) * parseInt(pageSize);
    const take = parseInt(pageSize);

    const where: any = {};
    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (userId) where.userId = userId;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take,
        include: { user: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      success: true,
      data: logs,
      pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize), totalPages: Math.ceil(total / take) },
    };
  });
};
