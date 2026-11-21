import { config, assertConfig } from './config.js';
import { logger } from './logger.js';
import { migrate, pool } from './db.js';
import { redis, reconcilePendingJobs, replyQueue } from './queue.js';
import { ZaloConnection } from './zalo/connection.js';
import { loginWithSaved } from './zalo/session.js';
import { startReplyWorker } from './worker.js';
import { acquireListenerLock } from './lock.js';
import { startHttp } from './http.js';

const role = config.role;
const runListener = role === 'all' || role === 'listener';
const runWorker = role === 'all' || role === 'worker';

let connection = null;
let worker = null;
let releaseLock = null;
const intervals = [];

async function main() {
  assertConfig(role);
  await migrate();
  startHttp(() => connection);

  if (runListener) {
    releaseLock = await acquireListenerLock(redis, () => shutdown('mất listener lock', 1));
    connection = new ZaloConnection();
    await connection.start();
  }

  if (runWorker) {
    let workerApi = null;
    const getZaloApi = async () => {
      if (connection?.api) return connection.api;
      // ROLE=worker tách riêng: dùng session đã lưu để gửi tin qua HTTP (không mở WebSocket)
      if (!workerApi) workerApi = await loginWithSaved();
      if (!workerApi) throw Object.assign(new Error('Chưa có session Zalo (listener chưa đăng nhập)'), { retryable: true });
      return workerApi;
    };
    const getBotUid = () => (connection?.botUid ? connection.botUid : String(workerApi?.getOwnId?.() || ''));
    worker = startReplyWorker(getZaloApi, getBotUid);
    await reconcilePendingJobs().catch((err) => logger.warn({ err: err.message }, 'reconcile lỗi'));
    intervals.push(setInterval(() => reconcilePendingJobs().catch(() => {}), 60000));
  }
  logger.info({ role }, 'zalo-agent đã khởi động');
}

let shuttingDown = false;
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn({ reason }, 'đang dừng...');
  intervals.forEach(clearInterval);
  const force = setTimeout(() => process.exit(code || 1), 20000);
  try {
    await connection?.stop();
    await worker?.close();
    await releaseLock?.();
    await replyQueue.close();
    await redis.quit();
    await pool.end();
  } catch (err) {
    logger.error({ err }, 'lỗi khi dừng');
  }
  clearTimeout(force);
  process.exit(code);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  shutdown('uncaughtException', 1);
});

main().catch((err) => {
  logger.fatal({ err }, 'khởi động thất bại');
  shutdown('startup failed', 1);
});
