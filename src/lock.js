import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

const RENEW_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Khoá đảm bảo chỉ 1 process nghe WebSocket cho 1 số Zalo.
 * 2 listener cùng số sẽ đá nhau liên tục (mã 3000) -> mất tin.
 */
export async function acquireListenerLock(redis, onLost) {
  const key = `zalo-agent:listener-lock:${config.zalo.accountKey}`;
  const token = randomUUID();
  const ttl = config.reliability.listenerLockTtlMs;
  let warned = false;
  for (;;) {
    const ok = await redis.set(key, token, 'PX', ttl, 'NX');
    if (ok) break;
    if (!warned) {
      logger.warn({ key }, 'đang có listener khác giữ khoá, chờ...');
      warned = true;
    }
    await new Promise((r) => setTimeout(r, ttl / 3));
  }
  logger.info({ key }, 'đã giữ listener lock');
  const timer = setInterval(async () => {
    try {
      const renewed = await redis.eval(RENEW_LUA, 1, key, token, ttl);
      if (!renewed) {
        clearInterval(timer);
        logger.error('mất listener lock');
        onLost();
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'gia hạn lock lỗi (sẽ thử lại)');
    }
  }, Math.floor(ttl / 3));
  return async () => {
    clearInterval(timer);
    await redis.eval(RELEASE_LUA, 1, key, token).catch(() => {});
  };
}
