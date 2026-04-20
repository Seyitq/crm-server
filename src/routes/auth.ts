import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { authenticate } from '../middleware/auth.js';
import { createAuditLog } from '../services/audit.service.js';

const loginSchema = z.object({
  username: z.string().min(1, 'Kullanıcı adı gerekli'),
  password: z.string().min(1, 'Şifre gerekli'),
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/auth/login
  fastify.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { username: body.username } });
    if (!user || !user.isActive) {
      return reply.status(401).send({ success: false, error: 'Geçersiz kullanıcı adı veya şifre' });
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ success: false, error: 'Geçersiz kullanıcı adı veya şifre' });
    }

    const accessToken = generateAccessToken({
      userId: user.id,
      username: user.username,
      role: user.role,
    });

    const refreshTokenRaw = generateRefreshToken(user.id);
    const hashedRefreshToken = crypto.createHash('sha256').update(refreshTokenRaw).digest('hex');

    // Store refresh token
    await prisma.refreshToken.create({
      data: {
        token: hashedRefreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Clean up old refresh tokens for this user (keep last 5)
    const tokens = await prisma.refreshToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      skip: 5,
    });
    if (tokens.length > 0) {
      await prisma.refreshToken.deleteMany({
        where: { id: { in: tokens.map(t => t.id) } },
      });
    }

    // Set cookie
    reply.setCookie('refreshToken', refreshTokenRaw, {
      httpOnly: true,
      secure: false, // LAN — no HTTPS
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 7 * 24 * 60 * 60,
    });

    await createAuditLog({
      userId: user.id,
      action: 'USER_LOGIN',
      entityType: 'User',
      entityId: user.id,
      description: `${user.fullName} sisteme giriş yaptı`,
      request,
    });

    return {
      success: true,
      data: {
        accessToken,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
          phone: user.phone,
          email: user.email,
        },
      },
    };
  });

  // POST /api/auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    const refreshTokenRaw = request.cookies.refreshToken;
    if (!refreshTokenRaw) {
      return reply.status(401).send({ success: false, error: 'Refresh token bulunamadı' });
    }

    try {
      const { userId } = verifyRefreshToken(refreshTokenRaw);
      const hashedToken = crypto.createHash('sha256').update(refreshTokenRaw).digest('hex');

      const storedToken = await prisma.refreshToken.findUnique({
        where: { token: hashedToken },
        include: { user: true },
      });

      if (!storedToken || storedToken.expiresAt < new Date() || !storedToken.user.isActive) {
        return reply.status(401).send({ success: false, error: 'Geçersiz veya süresi dolmuş token' });
      }

      const accessToken = generateAccessToken({
        userId: storedToken.user.id,
        username: storedToken.user.username,
        role: storedToken.user.role,
      });

      return { success: true, data: { accessToken } };
    } catch {
      return reply.status(401).send({ success: false, error: 'Geçersiz refresh token' });
    }
  });

  // POST /api/auth/logout
  fastify.post('/logout', { preHandler: [authenticate] }, async (request, reply) => {
    const refreshTokenRaw = request.cookies.refreshToken;
    if (refreshTokenRaw) {
      const hashedToken = crypto.createHash('sha256').update(refreshTokenRaw).digest('hex');
      await prisma.refreshToken.deleteMany({ where: { token: hashedToken } });
    }
    reply.clearCookie('refreshToken', { path: '/api/auth' });
    return { success: true };
  });

  // GET /api/auth/me
  fastify.get('/me', { preHandler: [authenticate] }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.userId },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        phone: true,
        email: true,
        projectAssignments: {
          select: { projectId: true },
        },
      },
    });

    if (!user) {
      return { success: false, error: 'Kullanıcı bulunamadı' };
    }

    return {
      success: true,
      data: {
        ...user,
        assignedProjectIds: user.projectAssignments.map(p => p.projectId),
      },
    };
  });
};
