import IORedis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

export function createRedisClient() {
  const client = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  client.on('error', (error) => logger.warn({ err: error.message }, 'Lỗi kết nối Redis'));
  return client;
}
