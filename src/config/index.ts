import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://crm_user:crm_password@localhost:5432/crm_db',
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'default-access-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'default-refresh-secret-change-me',
    accessExpiresIn: '8h',
    refreshExpiresIn: '7d',
  },

  backup: {
    directory: process.env.BACKUP_DIR || './backups',
    intervalHours: 6,
    maxBackups: 6,          // 6 yedek dolunca temizlik başlar
    deleteCount: 3,         // temizlikte en eski 3 yedek silinir
    diskWarningPercent: 80, // disk %80 dolunca admin'e bildirim
  },

  deposit: {
    checkIntervalCron: '0 * * * *', // Every hour
  },

  lock: {
    timeoutMinutes: 10,
    cleanupIntervalCron: '*/5 * * * *', // Every 5 minutes
  },

  updateServer: {
    port: parseInt(process.env.UPDATE_SERVER_PORT || '3002', 10),
  },

  storage: {
    contractsDir: path.resolve(__dirname, '../../storage/contracts'),
    uploadsDir: path.resolve(__dirname, '../../storage/uploads'),
  },
} as const;
