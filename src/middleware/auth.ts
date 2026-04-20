import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, AccessTokenPayload } from '../utils/jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AccessTokenPayload;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ success: false, error: 'Yetkilendirme token\'ı bulunamadı' });
  }

  const token = authHeader.substring(7);
  try {
    request.user = verifyAccessToken(token);
  } catch {
    return reply.status(401).send({ success: false, error: 'Geçersiz veya süresi dolmuş token' });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.role !== 'ADMIN') {
    return reply.status(403).send({ success: false, error: 'Bu işlem için yetkiniz bulunmuyor' });
  }
}

export function getClientIp(request: FastifyRequest): string {
  return (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || request.ip
    || 'unknown';
}
