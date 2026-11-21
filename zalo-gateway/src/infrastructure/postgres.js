import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

export function createPostgresPool() {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on('error', (error) => logger.error({ err: error }, 'Lỗi kết nối Postgres'));
  return pool;
}
