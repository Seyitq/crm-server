import { prisma } from '../lib/prisma.js';
import { getClientIp } from '../middleware/auth.js';
import { FastifyRequest } from 'fastify';

interface AuditLogParams {
  userId?: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: unknown;
  afterState?: unknown;
  description?: string;
  request?: FastifyRequest;
}

export async function createAuditLog(params: AuditLogParams): Promise<void> {
  const { userId, action, entityType, entityId, beforeState, afterState, description, request } = params;

  await prisma.auditLog.create({
    data: {
      userId: userId || null,
      action,
      entityType,
      entityId,
      beforeState: beforeState ? JSON.stringify(beforeState) : null,
      afterState: afterState ? JSON.stringify(afterState) : null,
      ipAddress: request ? getClientIp(request) : null,
      description,
    },
  });
}
