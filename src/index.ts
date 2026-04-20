import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { unitRoutes } from './routes/units.js';
import { customerRoutes } from './routes/customers.js';
import { depositRoutes } from './routes/deposits.js';
import { saleRoutes } from './routes/sales.js';
import { contractRoutes } from './routes/contracts.js';
import { notificationRoutes } from './routes/notifications.js';
import { adminRoutes } from './routes/admin.js';
import { reportRoutes } from './routes/reports.js';
import { systemRoutes } from './routes/system.js';
import { taskRoutes } from './routes/tasks.js';
import { wsHandler } from './ws/handler.js';
import { startDepositExpiryJob } from './jobs/deposit-expiry.js';
import { startBackupCheckJob } from './jobs/backup-check.js';
import { startLockCleanupJob, startOverdueInstallmentCheckJob } from './jobs/lock-cleanup.js';
import { prisma } from './lib/prisma.js';
import fs from 'fs';
import path from 'path';

const app = Fastify({
  logger: true,
  trustProxy: true,
});

async function start() {
  // Validate JWT secrets on startup
  const DEFAULT_ACCESS  = 'default-access-secret-change-me';
  const DEFAULT_REFRESH = 'default-refresh-secret-change-me';
  if (config.jwt.accessSecret === DEFAULT_ACCESS || config.jwt.refreshSecret === DEFAULT_REFRESH) {
    console.warn('⚠️  GÜVENLIK UYARISI: JWT secrets varsayılan değerlerde! Lütfen .env dosyasında JWT_ACCESS_SECRET ve JWT_REFRESH_SECRET değiştirin.');
  }

  // Ensure storage directories exist
  for (const dir of [config.storage.contractsDir, config.storage.uploadsDir, config.backup.directory]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: false, // CORS/CSP managed by Tauri
    crossOriginEmbedderPolicy: false,
  });

  // Rate limiting — global (generous) + stricter on auth routes
  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      success: false,
      error: 'Çok fazla istek gönderildi. Lütfen bekleyin.',
    }),
  });

  // Plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(cookie, {
    secret: config.jwt.refreshSecret,
  });

  await app.register(websocket);

  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB
    },
  });

  // Serve contract PDFs
  await app.register(fastifyStatic, {
    root: config.storage.contractsDir,
    prefix: '/files/contracts/',
    decorateReply: false,
  });

  // Serve uploaded files (floor plan images etc.)
  await app.register(fastifyStatic, {
    root: config.storage.uploadsDir,
    prefix: '/files/uploads/',
    decorateReply: false,
  });

  // WebSocket endpoint
  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, wsHandler);
  });

  // API Routes
  // Auth routes with stricter rate limit (20 req / 15 min)
  app.register(async (fastify) => {
    await fastify.register(rateLimit, {
      max: 20,
      timeWindow: '15 minutes',
      errorResponseBuilder: () => ({
        success: false,
        error: 'Çok fazla giriş denemesi. 15 dakika bekleyin.',
      }),
    });
    fastify.register(authRoutes);
  }, { prefix: '/api/auth' });
  app.register(projectRoutes, { prefix: '/api/projects' });
  app.register(unitRoutes, { prefix: '/api/units' });
  app.register(customerRoutes, { prefix: '/api/customers' });
  app.register(depositRoutes, { prefix: '/api/deposits' });
  app.register(saleRoutes, { prefix: '/api/sales' });
  app.register(contractRoutes, { prefix: '/api/contracts' });
  app.register(notificationRoutes, { prefix: '/api/notifications' });
  app.register(adminRoutes, { prefix: '/api/admin' });
  app.register(reportRoutes, { prefix: '/api/reports' });
  app.register(systemRoutes, { prefix: '/api/system' });
  app.register(taskRoutes, { prefix: '/api/tasks' });

  // Health check
  app.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // Start background jobs
  startDepositExpiryJob();
  startBackupCheckJob();
  startLockCleanupJob();
  startOverdueInstallmentCheckJob();

  // Verify database connection
  try {
    await prisma.$connect();
    console.log('✅ Database connected');
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }

  // Start server
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`🚀 Server running on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

start();
