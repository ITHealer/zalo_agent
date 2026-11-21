// Composition root của zalo-gateway: khởi tạo và nối các thành phần với nhau.
import os from 'node:os';
import { ThreadType } from 'zca-js';
import { logger } from './logger.js';
import { STREAMS, CONSUMER_GROUPS } from './contracts.js';
import { createPostgresPool } from './infrastructure/postgres.js';
import { createRedisClient } from './infrastructure/redis.js';
import { StreamPublisher, StreamConsumer } from './infrastructure/redis-streams.js';
import { ListenerLock } from './infrastructure/listener-lock.js';
import { MessageRepository } from './repositories/message-repository.js';
import { ThreadRepository } from './repositories/thread-repository.js';
import { ReplyJobRepository } from './repositories/reply-job-repository.js';
import { OutboxRepository } from './repositories/outbox-repository.js';
import { StateRepository } from './repositories/state-repository.js';
import { ZaloSessionManager } from './zalo/zalo-session.js';
import { ZaloConnection } from './zalo/zalo-connection.js';
import { HistorySweeper } from './zalo/history-sweeper.js';
import { MessageIngestor } from './services/message-ingestor.js';
import { OutboxSender } from './services/outbox-sender.js';
import { GatewayStatusPublisher } from './services/gateway-status-publisher.js';
import { startHealthServer } from './http/health-server.js';

const postgresPool = createPostgresPool();
const redisClient = createRedisClient();
const redisClientForConsumer = createRedisClient(); // XREADGROUP BLOCK chiếm riêng 1 kết nối

const messageRepository = new MessageRepository(postgresPool);
const threadRepository = new ThreadRepository(postgresPool);
const replyJobRepository = new ReplyJobRepository(postgresPool);
const outboxRepository = new OutboxRepository(postgresPool);
const stateRepository = new StateRepository(postgresPool);

let zaloConnection = null;
const getZaloSession = () => ({ api: zaloConnection?.api || null, botUid: zaloConnection?.botUid || null });

const messageIngestor = new MessageIngestor({
  messageRepository,
  threadRepository,
  replyJobRepository,
  streamPublisher: new StreamPublisher(redisClient),
  onReplyQueued: (message) => {
    // Hiện "đang soạn tin" ngay khi nhận câu hỏi để người hỏi biết bot đã thấy
    const { api } = getZaloSession();
    const zaloThreadType = message.threadType === 'group' ? ThreadType.Group : ThreadType.User;
    api?.sendTypingEvent(message.threadId, zaloThreadType).catch(() => {});
  },
});

const historySweeper = new HistorySweeper({ getZaloSession, messageIngestor, threadRepository });
const outboxSender = new OutboxSender({ getZaloSession, outboxRepository, replyJobRepository, messageRepository });
const outboxConsumer = new StreamConsumer({
  redisClient: redisClientForConsumer,
  streamName: STREAMS.outbox,
  groupName: CONSUMER_GROUPS.gateway,
  consumerName: `${os.hostname()}-${process.pid}`,
  handleMessage: (payload) => outboxSender.handleOutboxRequest(payload),
});

const collectStatus = () => ({
  zalo: zaloConnection ? zaloConnection.getStatus() : { state: 'idle' },
  ingest: messageIngestor.stats,
  sweep: historySweeper.stats,
  outbox: outboxSender.stats,
});
const statusPublisher = new GatewayStatusPublisher(redisClient, collectStatus);
const listenerLock = new ListenerLock(redisClient);

async function main() {
  startHealthServer(collectStatus);
  statusPublisher.start();

  await listenerLock.acquire(() => shutdown('Mất khoá listener', 1));

  const sessionManager = new ZaloSessionManager(stateRepository, (qrCode) => statusPublisher.publishQrCode(qrCode));
  zaloConnection = new ZaloConnection({
    sessionManager,
    messageIngestor,
    messageRepository,
    stateRepository,
    historySweeper,
  });
  await zaloConnection.start(); // chờ đăng nhập (có thể chờ quét QR)

  historySweeper.start();
  await outboxConsumer.start();
  outboxSender.startReconciler();
  await outboxSender.sendStalePendingReplies();
  logger.info('zalo-gateway đã sẵn sàng');
}

let isShuttingDown = false;
async function shutdown(reason, exitCode = 0) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.warn({ reason }, 'Đang dừng zalo-gateway...');
  const forceExitTimer = setTimeout(() => process.exit(exitCode || 1), 15000);
  try {
    historySweeper.stop();
    outboxSender.stopReconciler();
    statusPublisher.stop();
    await zaloConnection?.stop();
    await outboxConsumer.stop().catch(() => {});
    await listenerLock.release();
    redisClientForConsumer.disconnect();
    await redisClient.quit();
    await postgresPool.end();
  } catch (error) {
    logger.error({ err: error }, 'Lỗi khi dừng');
  }
  clearTimeout(forceExitTimer);
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => logger.error({ err: error }, 'unhandledRejection'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaughtException');
  shutdown('uncaughtException', 1);
});

main().catch((error) => {
  logger.fatal({ err: error }, 'Khởi động thất bại');
  shutdown('Khởi động thất bại', 1);
});
