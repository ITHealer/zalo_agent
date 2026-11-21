import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';
import { getPendingReplyJobs } from './db.js';

export const QUEUE_NAME = 'zalo-replies';

export function createRedis() {
  const r = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  r.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  return r;
}

export const redis = createRedis();

export const replyQueue = new Queue(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: config.reply.maxAttempts,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 24 * 3600, count: 5000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

/** jobId = msgId -> BullMQ tự chống trùng nếu enqueue nhiều lần. */
export async function enqueueReply(msgId) {
  await replyQueue.add('reply', { msgId }, { jobId: `reply-${msgId}` });
}

/**
 * Lưới an toàn: job trong DB chưa xong mà không còn trong Redis (vd Redis mất dữ liệu,
 * process chết giữa lúc ghi DB và enqueue) -> đưa lại vào hàng đợi.
 */
export async function reconcilePendingJobs() {
  const ids = await getPendingReplyJobs(2 * 60 * 1000);
  let requeued = 0;
  for (const msgId of ids) {
    const job = await replyQueue.getJob(`reply-${msgId}`);
    if (job) {
      const state = await job.getState();
      if (['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'].includes(state)) continue;
      if (state === 'failed') continue; // đã hết lượt retry, giữ nguyên trạng thái failed trong DB
      await job.remove().catch(() => {});
    }
    await enqueueReply(msgId);
    requeued++;
  }
  if (requeued) logger.warn({ requeued }, 'reconciled pending reply jobs');
  return requeued;
}
