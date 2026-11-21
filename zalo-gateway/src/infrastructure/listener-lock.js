import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { REDIS_KEYS } from '../contracts.js';

const RENEW_IF_OWNER_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/**
 * Đảm bảo chỉ 1 process nghe WebSocket cho 1 số Zalo.
 * 2 listener cùng số sẽ đá nhau liên tục (mã 3000) và gây mất tin.
 */
export class ListenerLock {
  constructor(redisClient) {
    this.redis = redisClient;
    this.key = REDIS_KEYS.listenerLockPrefix + config.zalo.accountKey;
    this.token = randomUUID();
    this.ttlMs = config.connection.listenerLockTtlMs;
    this.renewTimer = null;
  }

  /** Chờ tới khi giữ được khoá. onLockLost được gọi nếu sau đó bị mất khoá. */
  async acquire(onLockLost) {
    let hasLoggedWaiting = false;
    while (true) {
      const result = await this.redis.set(this.key, this.token, 'PX', this.ttlMs, 'NX');
      if (result === 'OK') {
        break;
      }
      if (!hasLoggedWaiting) {
        logger.warn({ key: this.key }, 'Đang có gateway khác giữ khoá listener, chờ...');
        hasLoggedWaiting = true;
      }
      await new Promise((resolve) => setTimeout(resolve, this.ttlMs / 3));
    }
    logger.info({ key: this.key }, 'Đã giữ khoá listener');
    this.renewTimer = setInterval(() => this.renew(onLockLost), Math.floor(this.ttlMs / 3));
  }

  async renew(onLockLost) {
    try {
      const renewed = await this.redis.eval(RENEW_IF_OWNER_SCRIPT, 1, this.key, this.token, this.ttlMs);
      if (!renewed) {
        clearInterval(this.renewTimer);
        logger.error('Mất khoá listener');
        onLockLost();
      }
    } catch (error) {
      logger.warn({ err: error.message }, 'Gia hạn khoá listener lỗi, sẽ thử lại');
    }
  }

  async release() {
    clearInterval(this.renewTimer);
    await this.redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, this.key, this.token).catch(() => {});
  }
}
