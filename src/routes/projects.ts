import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { createAuditLog } from '../services/audit.service.js';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import crypto from 'crypto';

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  address: z.string().optional(),
  imageUrl: z.string().optional(),
});

const createBlockSchema = z.object({
  name: z.string().min(1),
  order: z.number().int().optional(),
});

const createFloorSchema = z.object({
  number: z.number().int(),
  label: z.string().optional(),
  svgContent: z.string().optional(),
});

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  // All routes require auth
  fastify.addHook('preHandler', authenticate);

  // GET /api/projects — list projects (filtered by role)
  fastify.get('/', async (request) => {
    const { userId, role } = request.user;

    let where: any = { isActive: true };

    if (role === 'SALES_CONSULTANT') {
      where = {
        isActive: true,
        userAssignments: { some: { userId } },
      };
    }

    const projects = await prisma.project.findMany({
      where,
      include: {
        blocks: {
          include: {
            units: { select: { status: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = projects.map(project => {
      const allUnits = project.blocks.flatMap(b => b.units);
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        address: project.address,
        imageUrl: project.imageUrl,
        isActive: project.isActive,
        totalUnits: allUnits.length,
        availableUnits: allUnits.filter(u => u.status === 'AVAILABLE').length,
        reservedUnits: allUnits.filter(u => u.status === 'RESERVED').length,
        soldUnits: allUnits.filter(u => u.status === 'SOLD').length,
      };
    });

    return { success: true, data };
  });

  // GET /api/projects/:id — project detail with blocks
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    const { userId, role } = request.user;

    // Check assignment for consultants
    if (role === 'SALES_CONSULTANT') {
      const assignment = await prisma.userProject.findUnique({
        where: { userId_projectId: { userId, projectId: id } },
      });
      if (!assignment) {
        return reply.status(403).send({ success: false, error: 'Bu projeye erişim yetkiniz yok' });
      }
    }

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        blocks: {
          orderBy: { order: 'asc' },
          include: {
            floors: {
              orderBy: { number: 'asc' },
              select: { id: true, number: true, label: true, blockId: true, _count: { select: { units: true } } },
            },
            units: { select: { status: true } },
          },
        },
      },
    });

    if (!project) {
      return reply.status(404).send({ success: false, error: 'Proje bulunamadı' });
    }

    const data = {
      ...project,
      blocks: project.blocks.map(block => ({
        id: block.id,
        name: block.name,
        order: block.order,
        floorCount: block.floors.length,
        floors: block.floors.map(f => ({
          id: f.id,
          number: f.number,
          label: f.label,
          blockId: f.blockId,
          _count: f._count,
        })),
        totalUnits: block.units.length,
        availableUnits: block.units.filter(u => u.status === 'AVAILABLE').length,
        reservedUnits: block.units.filter(u => u.status === 'RESERVED').length,
        soldUnits: block.units.filter(u => u.status === 'SOLD').length,
      })),
    };

    return { success: true, data };
  });

  // GET /api/projects/floors/:floorId — direct floor lookup by ID
  fastify.get<{ Params: { floorId: string } }>('/floors/:floorId', async (request, reply) => {
    const { floorId } = request.params;

    const floor = await prisma.floor.findUnique({
      where: { id: floorId },
      include: {
        units: {
          include: {
            locks: {
              include: { user: { select: { fullName: true } } },
            },
          },
        },
        planAreas: {
          include: {
            unit: {
              select: {
                id: true,
                code: true,
                status: true,
                type: true,
                area: true,
                price: true,
                orientation: true,
              },
            },
          },
        },
      },
    });

    if (!floor) {
      return reply.status(404).send({ success: false, error: 'Kat bulunamadı' });
    }

    return {
      success: true,
      data: {
        id: floor.id,
        number: floor.number,
        label: floor.label,
        blockId: floor.blockId,
        svgContent: floor.svgContent,
        planImageUrl: floor.planImageUrl,
        units: floor.units.map(unit => ({
          id: unit.id,
          code: unit.code,
          type: unit.type,
          area: unit.area?.toString(),
          price: unit.price.toString(),
          status: unit.status,
          orientation: (unit as any).orientation || null,
          svgId: unit.code,
        })),
        planAreas: floor.planAreas.map(area => ({
          id: area.id,
          floorId: area.floorId,
          unitId: area.unitId,
          polygon: JSON.parse(area.polygon),
          label: area.label,
          unit: area.unit ? {
            ...area.unit,
            area: area.unit.area?.toString(),
            price: area.unit.price.toString(),
          } : null,
        })),
      },
    };
  });

  // POST /api/projects — create project (admin only)
  fastify.post('/', { preHandler: [requireAdmin] }, async (request) => {
    const body = createProjectSchema.parse(request.body);

    const project = await prisma.project.create({ data: body });

    await createAuditLog({
      userId: request.user.userId,
      action: 'PROJECT_CREATED',
      entityType: 'Project',
      entityId: project.id,
      afterState: project,
      description: `Proje oluşturuldu: ${project.name}`,
      request,
    });

    return { success: true, data: project };
  });

  // PUT /api/projects/:id — update project (admin only)
  fastify.put<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params;
    const body = createProjectSchema.partial().parse(request.body);

    const existing = await prisma.project.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Proje bulunamadı' });
    }

    const project = await prisma.project.update({ where: { id }, data: body });

    await createAuditLog({
      userId: request.user.userId,
      action: 'PROJECT_UPDATED',
      entityType: 'Project',
      entityId: project.id,
      beforeState: existing,
      afterState: project,
      description: `Proje güncellendi: ${project.name}`,
      request,
    });

    return { success: true, data: project };
  });

  // POST /api/projects/:id/blocks — add block (admin only)
  fastify.post<{ Params: { id: string } }>('/:id/blocks', { preHandler: [requireAdmin] }, async (request) => {
    const { id: projectId } = request.params;
    const body = createBlockSchema.parse(request.body);

    const block = await prisma.block.create({
      data: { ...body, projectId },
    });

    await createAuditLog({
      userId: request.user.userId,
      action: 'BLOCK_CREATED',
      entityType: 'Block',
      entityId: block.id,
      afterState: block,
      description: `Blok oluşturuldu: ${block.name}`,
      request,
    });

    return { success: true, data: block };
  });

  // POST /api/projects/:projectId/blocks/:blockId/floors — add floor (admin only)
  fastify.post<{ Params: { projectId: string; blockId: string } }>(
    '/:projectId/blocks/:blockId/floors',
    { preHandler: [requireAdmin] },
    async (request) => {
      const { blockId } = request.params;
      const body = createFloorSchema.parse(request.body);

      const floor = await prisma.floor.create({
        data: { ...body, blockId },
      });

      await createAuditLog({
        userId: request.user.userId,
        action: 'FLOOR_CREATED',
        entityType: 'Floor',
        entityId: floor.id,
        afterState: floor,
        description: `Kat oluşturuldu: ${body.label || `Kat ${body.number}`}`,
        request,
      });

      return { success: true, data: floor };
    }
  );

  // PUT /api/projects/:projectId/blocks/:blockId/floors/:floorId/svg — upload SVG
  fastify.put<{ Params: { projectId: string; blockId: string; floorId: string } }>(
    '/:projectId/blocks/:blockId/floors/:floorId/svg',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { floorId } = request.params;
      const { svgContent } = z.object({ svgContent: z.string().min(1) }).parse(request.body);

      // Validate SVG has polygon/path elements with id attributes
      const idPattern = /id=["']([^"']+)["']/g;
      const ids: string[] = [];
      let match;
      while ((match = idPattern.exec(svgContent)) !== null) {
        ids.push(match[1]);
      }

      if (ids.length === 0) {
        return reply.status(400).send({
          success: false,
          error: 'SVG dosyasında id attribute\'u olan polygon veya path elementi bulunamadı',
        });
      }

      const floor = await prisma.floor.update({
        where: { id: floorId },
        data: { svgContent },
      });

      return { success: true, data: { floorId: floor.id, unitCodes: ids } };
    }
  );

  // GET /api/projects/:projectId/blocks/:blockId/floors/:floorId — floor detail with SVG and units
  fastify.get<{ Params: { projectId: string; blockId: string; floorId: string } }>(
    '/:projectId/blocks/:blockId/floors/:floorId',
    async (request, reply) => {
      const { floorId } = request.params;

      const floor = await prisma.floor.findUnique({
        where: { id: floorId },
        include: {
          units: {
            include: {
              locks: {
                include: { user: { select: { fullName: true } } },
              },
            },
          },
        },
      });

      if (!floor) {
        return reply.status(404).send({ success: false, error: 'Kat bulunamadı' });
      }

      const unitStatusMap: Record<string, any> = {};
      for (const unit of floor.units) {
        const activeLock = unit.locks.find(l => l.expiresAt > new Date());
        unitStatusMap[unit.code] = {
          id: unit.id,
          status: unit.status,
          type: unit.type,
          area: unit.area?.toString(),
          price: unit.price.toString(),
          isLocked: !!activeLock,
          lockedBy: activeLock?.user?.fullName || null,
        };
      }

      return {
        success: true,
        data: {
          id: floor.id,
          number: floor.number,
          label: floor.label,
          blockId: floor.blockId,
          svgContent: floor.svgContent,
          units: unitStatusMap,
        },
      };
    }
  );

  // DELETE /api/projects/:id — soft delete project (admin only)
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params;

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        blocks: {
          include: {
            units: {
              where: { status: { in: ['SOLD', 'RESERVED'] } },
              select: { id: true },
            },
          },
        },
      },
    });

    if (!project) {
      return reply.status(404).send({ success: false, error: 'Proje bulunamadı' });
    }

    const hasActiveUnits = project.blocks.some(b => b.units.length > 0);
    if (hasActiveUnits) {
      return reply.status(400).send({ success: false, error: 'Satılmış veya kaparolu birimleri olan proje silinemez' });
    }

    await prisma.project.update({ where: { id }, data: { isActive: false } });

    await createAuditLog({
      userId: request.user.userId,
      action: 'PROJECT_DELETED',
      entityType: 'Project',
      entityId: id,
      beforeState: project,
      description: `Proje silindi: ${project.name}`,
      request,
    });

    return { success: true };
  });

  // DELETE /api/projects/:projectId/blocks/:blockId — delete block (admin only)
  fastify.delete<{ Params: { projectId: string; blockId: string } }>(
    '/:projectId/blocks/:blockId',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { blockId } = request.params;

      const block = await prisma.block.findUnique({
        where: { id: blockId },
        include: {
          units: {
            where: { status: { in: ['SOLD', 'RESERVED'] } },
            select: { id: true },
          },
        },
      });

      if (!block) {
        return reply.status(404).send({ success: false, error: 'Blok bulunamadı' });
      }

      if (block.units.length > 0) {
        return reply.status(400).send({ success: false, error: 'Satılmış veya kaparolu birimleri olan blok silinemez' });
      }

      await prisma.block.delete({ where: { id: blockId } });

      await createAuditLog({
        userId: request.user.userId,
        action: 'BLOCK_DELETED',
        entityType: 'Block',
        entityId: blockId,
        beforeState: block,
        description: `Blok silindi: ${block.name}`,
        request,
      });

      return { success: true };
    }
  );

  // DELETE /api/projects/:projectId/blocks/:blockId/floors/:floorId — delete floor (admin only)
  fastify.delete<{ Params: { projectId: string; blockId: string; floorId: string } }>(
    '/:projectId/blocks/:blockId/floors/:floorId',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { floorId } = request.params;

      const floor = await prisma.floor.findUnique({
        where: { id: floorId },
        include: {
          units: {
            where: { status: { in: ['SOLD', 'RESERVED'] } },
            select: { id: true },
          },
        },
      });

      if (!floor) {
        return reply.status(404).send({ success: false, error: 'Kat bulunamadı' });
      }

      if (floor.units.length > 0) {
        return reply.status(400).send({ success: false, error: 'Satılmış veya kaparolu birimleri olan kat silinemez' });
      }

      await prisma.floor.delete({ where: { id: floorId } });

      await createAuditLog({
        userId: request.user.userId,
        action: 'FLOOR_DELETED',
        entityType: 'Floor',
        entityId: floorId,
        beforeState: floor,
        description: `Kat silindi: ${floor.label || `Kat ${floor.number}`}`,
        request,
      });

      return { success: true };
    }
  );

  // ==================== FLOOR PLAN IMAGE ====================

  // POST /api/projects/floors/:floorId/plan-image — upload floor plan image
  fastify.post<{ Params: { floorId: string } }>(
    '/floors/:floorId/plan-image',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { floorId } = request.params;

      const floor = await prisma.floor.findUnique({ where: { id: floorId } });
      if (!floor) {
        return reply.status(404).send({ success: false, error: 'Kat bulunamadı' });
      }

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ success: false, error: 'Dosya gerekli' });
      }

      const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
      if (!allowedTypes.includes(data.mimetype)) {
        return reply.status(400).send({ success: false, error: 'Sadece PNG, JPG ve WebP dosyaları desteklenir' });
      }

      // Generate unique filename
      const ext = path.extname(data.filename) || '.png';
      const filename = `floor-plan-${floorId}-${crypto.randomBytes(8).toString('hex')}${ext}`;
      const uploadDir = path.join(config.storage.uploadsDir, 'floor-plans');

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const filePath = path.join(uploadDir, filename);
      const buffer = await data.toBuffer();
      fs.writeFileSync(filePath, buffer);

      // Delete old image if exists
      if (floor.planImageUrl) {
        const oldPath = path.join(config.storage.uploadsDir, floor.planImageUrl.replace('/files/uploads/', ''));
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }

      const planImageUrl = `/files/uploads/floor-plans/${filename}`;
      await prisma.floor.update({
        where: { id: floorId },
        data: { planImageUrl },
      });

      await createAuditLog({
        userId: request.user.userId,
        action: 'FLOOR_PLAN_UPLOADED',
        entityType: 'Floor',
        entityId: floorId,
        description: `Kat planı görseli yüklendi`,
        request,
      });

      return { success: true, data: { planImageUrl } };
    }
  );

  // DELETE /api/projects/floors/:floorId/plan-image — remove floor plan image
  fastify.delete<{ Params: { floorId: string } }>(
    '/floors/:floorId/plan-image',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { floorId } = request.params;

      const floor = await prisma.floor.findUnique({ where: { id: floorId } });
      if (!floor) {
        return reply.status(404).send({ success: false, error: 'Kat bulunamadı' });
      }

      if (floor.planImageUrl) {
        const oldPath = path.join(config.storage.uploadsDir, floor.planImageUrl.replace('/files/uploads/', ''));
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }

      await prisma.floor.update({
        where: { id: floorId },
        data: { planImageUrl: null },
      });

      // Also remove plan areas
      await prisma.floorPlanArea.deleteMany({ where: { floorId } });

      return { success: true };
    }
  );

  // ==================== FLOOR PLAN AREAS ====================

  // PUT /api/projects/floors/:floorId/plan-areas — bulk save plan areas (replace all)
  fastify.put<{ Params: { floorId: string } }>(
    '/floors/:floorId/plan-areas',
    { preHandler: [requireAdmin] },
    async (request, reply) => {
      const { floorId } = request.params;

      const floor = await prisma.floor.findUnique({
        where: { id: floorId },
        include: { units: { select: { id: true } } },
      });
      if (!floor) {
        return reply.status(404).send({ success: false, error: 'Kat bulunamadı' });
      }

      const areaSchema = z.object({
        areas: z.array(z.object({
          unitId: z.string(),
          polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(3),
          label: z.string().optional(),
        })),
      });

      const body = areaSchema.parse(request.body);

      // Validate all unitIds belong to this floor
      const floorUnitIds = new Set(floor.units.map(u => u.id));
      for (const area of body.areas) {
        if (!floorUnitIds.has(area.unitId)) {
          return reply.status(400).send({
            success: false,
            error: `Birim ${area.unitId} bu kata ait değil`,
          });
        }
      }

      // Transaction: delete old, create new
      await prisma.$transaction(async (tx) => {
        await tx.floorPlanArea.deleteMany({ where: { floorId } });

        for (const area of body.areas) {
          await tx.floorPlanArea.create({
            data: {
              floorId,
              unitId: area.unitId,
              polygon: JSON.stringify(area.polygon),
              label: area.label,
            },
          });
        }
      });

      await createAuditLog({
        userId: request.user.userId,
        action: 'FLOOR_PLAN_AREAS_UPDATED',
        entityType: 'Floor',
        entityId: floorId,
        description: `Kat planı alanları güncellendi (${body.areas.length} alan)`,
        request,
      });

      return { success: true, data: { count: body.areas.length } };
    }
  );

  // GET /api/projects/floors/:floorId/plan-areas — get plan areas for a floor
  fastify.get<{ Params: { floorId: string } }>(
    '/floors/:floorId/plan-areas',
    async (request, reply) => {
      const { floorId } = request.params;

      const areas = await prisma.floorPlanArea.findMany({
        where: { floorId },
        include: {
          unit: {
            select: {
              id: true,
              code: true,
              status: true,
              type: true,
              area: true,
              price: true,
              orientation: true,
            },
          },
        },
      });

      return {
        success: true,
        data: areas.map(area => ({
          id: area.id,
          floorId: area.floorId,
          unitId: area.unitId,
          polygon: JSON.parse(area.polygon),
          label: area.label,
          unit: area.unit ? {
            ...area.unit,
            area: area.unit.area?.toString(),
            price: area.unit.price.toString(),
          } : null,
        })),
      };
    }
  );
};
