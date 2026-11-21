import { REDIS_KEYS } from '../contracts.js';
import { logger } from '../logger.js';

const STATUS_PUBLISH_INTERVAL_MS = 10000;
const STATUS_TTL_SECONDS = 60; // hết hạn = gateway đã chết / treo
const QR_TTL_SECONDS = 300;

/**
 * Công bố trạng thái gateway và mã QR lên Redis để agent-service (FastAPI) hiển thị.
 */
export class GatewayStatusPublisher {
  /**
   * @param {import('ioredis').Redis} redisClient
   * @param {() => object} collectStatus
   */
  constructor(redisClient, collectStatus) {
    this.redis = redisClient;
    this.collectStatus = collectStatus;
    this.timer = null;
  }

  start() {
    this.publishStatus();
    this.timer = setInterval(() => this.publishStatus(), STATUS_PUBLISH_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async publishStatus() {
    try {
      const status = { ...this.collectStatus(), publishedAt: new Date().toISOString() };
      await this.redis.set(REDIS_KEYS.gatewayStatus, JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);
    } catch (error) {
      logger.warn({ err: error.message }, 'Công bố trạng thái gateway lỗi');
    }
  }

  async publishQrCode(qrCode) {
    if (qrCode.status === 'logged_in') {
      await this.redis.del(REDIS_KEYS.gatewayQr);
      return;
    }
    const current = JSON.parse((await this.redis.get(REDIS_KEYS.gatewayQr)) || '{}');
    const merged = { ...current, ...qrCode };
    await this.redis.set(REDIS_KEYS.gatewayQr, JSON.stringify(merged), 'EX', QR_TTL_SECONDS);
  }
}
