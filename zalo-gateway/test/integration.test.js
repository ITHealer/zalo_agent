// Test tích hợp TOÀN HỆ THỐNG: zalo-gateway (Zalo giả lập) + Postgres + Redis + agent-service (đang chạy) + OpenWebUI.
//
// Chuẩn bị: Postgres, Redis, OpenWebUI và agent-service (uvicorn) đang chạy, sau đó:
//   INTEGRATION=1 npm run test:integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const isEnabled = process.env.INTEGRATION === '1';
process.env.LOG_LEVEL ||= 'warn';
process.env.REPLY_DELAY_MIN_MS = '10';
process.env.REPLY_DELAY_MAX_MS = '20';
process.env.SEND_MIN_INTERVAL_MS = '0';
process.env.SWEEP_DELAY_BETWEEN_GROUPS_MS = '10';
process.env.OUTBOX_RECONCILE_INTERVAL_MS = '500';

const BOT_UID = '1000';
const GROUP_ID = `g-it-${Date.now()}`;
let lastMsgId = BigInt(Date.now()) * 1000n;
const nextMsgId = () => String(++lastMsgId);

const sentToZalo = [];
let cloudMessagesForSweep = [];

const fakeZaloApi = {
  getOwnId: () => BOT_UID,
  sendTypingEvent: async () => ({ status: 1 }),
  sendMessage: async (messageContent, threadId) => {
    const msgId = nextMsgId();
    sentToZalo.push({ messageContent, threadId, msgId });
    return { message: { msgId: Number(msgId) }, attachment: [] };
  },
  getAllGroups: async () => ({ gridVerMap: { [GROUP_ID]: '1' } }),
  getGroupInfo: async () => ({ gridInfoMap: { [GROUP_ID]: { name: 'Nhóm Tích Hợp' } } }),
  getCloudMessage: async () => ({ groupMsgs: cloudMessagesForSweep, hasMore: 0, isOld: 0, lastMsgId: '0' }),
};

let modules;
let components;

function makeGroupMessage({ text, mentionsBot = false, senderUid = '2000', timestamp = Date.now() }) {
  const msgId = nextMsgId();
  return new modules.GroupMessage(BOT_UID, {
    msgId,
    cliMsgId: msgId,
    msgType: 'webchat',
    uidFrom: senderUid,
    idTo: GROUP_ID,
    dName: 'Khách Test',
    ts: String(timestamp),
    content: text,
    mentions: mentionsBot ? [{ uid: BOT_UID, pos: 0, len: 4, type: 0 }] : undefined,
    ttl: 0,
  });
}

async function waitUntil(checkCondition, timeoutMs = 60000) {
  const startedAt = Date.now();
  while (true) {
    const result = await checkCondition();
    if (result) {
      return result;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Hết thời gian chờ');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const replyStatusOf = async (msgId) => (await components.replyJobRepository.findById(msgId))?.status;

before(async () => {
  if (!isEnabled) {
    return;
  }
  const { GroupMessage } = await import('zca-js');
  const { STREAMS, CONSUMER_GROUPS } = await import('../src/contracts.js');
  const { createPostgresPool } = await import('../src/infrastructure/postgres.js');
  const { createRedisClient } = await import('../src/infrastructure/redis.js');
  const { StreamPublisher, StreamConsumer } = await import('../src/infrastructure/redis-streams.js');
  const { MessageRepository } = await import('../src/repositories/message-repository.js');
  const { ThreadRepository } = await import('../src/repositories/thread-repository.js');
  const { ReplyJobRepository } = await import('../src/repositories/reply-job-repository.js');
  const { OutboxRepository } = await import('../src/repositories/outbox-repository.js');
  const { MessageIngestor } = await import('../src/services/message-ingestor.js');
  const { OutboxSender } = await import('../src/services/outbox-sender.js');
  const { HistorySweeper } = await import('../src/zalo/history-sweeper.js');
  modules = { GroupMessage };

  const pool = createPostgresPool();
  const redis = createRedisClient();
  const redisForConsumer = createRedisClient();
  const messageRepository = new MessageRepository(pool);
  const threadRepository = new ThreadRepository(pool);
  const replyJobRepository = new ReplyJobRepository(pool);
  const outboxRepository = new OutboxRepository(pool);
  const getZaloSession = () => ({ api: fakeZaloApi, botUid: BOT_UID });

  const messageIngestor = new MessageIngestor({
    messageRepository,
    threadRepository,
    replyJobRepository,
    streamPublisher: new StreamPublisher(redis),
  });
  const outboxSender = new OutboxSender({ getZaloSession, outboxRepository, replyJobRepository, messageRepository });
  const outboxConsumer = new StreamConsumer({
    redisClient: redisForConsumer,
    streamName: STREAMS.outbox,
    groupName: CONSUMER_GROUPS.gateway,
    consumerName: 'integration-test',
    handleMessage: (payload) => outboxSender.handleOutboxRequest(payload),
  });
  await outboxConsumer.start();
  const historySweeper = new HistorySweeper({ getZaloSession, messageIngestor, threadRepository });

  components = {
    pool,
    redis,
    redisForConsumer,
    messageRepository,
    threadRepository,
    replyJobRepository,
    messageIngestor,
    outboxSender,
    outboxConsumer,
    historySweeper,
  };
});

after(async () => {
  if (!isEnabled) {
    return;
  }
  await components.outboxConsumer.stop();
  components.redisForConsumer.disconnect();
  await components.redis.quit();
  await components.pool.end();
});

test('tin thường: chỉ lưu, không tạo yêu cầu trả lời', { skip: !isEnabled }, async () => {
  const message = makeGroupMessage({ text: 'Chào cả nhà, tour Đà Lạt tháng 12 còn chỗ không?' });
  const result = await components.messageIngestor.ingest(message, BOT_UID, 'live');
  assert.equal(result.isNew, true);
  assert.equal(result.triggersBot, false);
  assert.equal(await components.replyJobRepository.findById(message.data.msgId), null);
});

test('tag bot -> agent-service hỏi OpenWebUI -> gateway gửi lại nhóm (quote + mention)', { skip: !isEnabled }, async () => {
  const message = makeGroupMessage({ text: '@Bot giá tour Nha Trang?', mentionsBot: true });
  await components.messageIngestor.ingest(message, BOT_UID, 'live');

  await waitUntil(async () => (await replyStatusOf(message.data.msgId)) === 'sent');
  const sentReply = sentToZalo.find((item) => item.messageContent.quote?.msgId === message.data.msgId);
  assert.ok(sentReply, 'phải gửi câu trả lời có quote tin gốc');
  assert.equal(sentReply.threadId, GROUP_ID);
  assert.match(sentReply.messageContent.msg, /^@Khách Test /);
  assert.deepEqual(sentReply.messageContent.mentions, [{ pos: 0, uid: '2000', len: '@Khách Test'.length }]);

  const replyJob = await components.replyJobRepository.findById(message.data.msgId);
  assert.ok(replyJob.answer.length > 0);
  assert.ok(replyJob.openwebui_chat_id, 'phải gọi OpenWebUI ở chế độ chat');
  console.log('   câu trả lời của agent:', replyJob.answer.slice(0, 100));
});

test('nhận trùng (live + backfill) chỉ trả lời 1 lần', { skip: !isEnabled }, async () => {
  const message = makeGroupMessage({ text: '@Bot còn tour Phú Quốc?', mentionsBot: true });
  await components.messageIngestor.ingest(message, BOT_UID, 'live');
  const duplicateResult = await components.messageIngestor.ingest(message, BOT_UID, 'ws_backfill');
  assert.equal(duplicateResult.isNew, false);

  await waitUntil(async () => (await replyStatusOf(message.data.msgId)) === 'sent');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const repliesForMessage = sentToZalo.filter((item) => item.messageContent.quote?.msgId === message.data.msgId);
  assert.equal(repliesForMessage.length, 1);
});

test('tin rớt khỏi WebSocket được quét bù qua HTTP và vẫn được trả lời', { skip: !isEnabled }, async () => {
  const missedQuestion = makeGroupMessage({ text: '@Bot tin này không qua websocket', mentionsBot: true });
  const missedNormal = makeGroupMessage({ text: 'tin thường bị rớt' });
  cloudMessagesForSweep = [missedQuestion, missedNormal];

  await components.historySweeper.sweepAllGroups();

  assert.ok(await components.messageRepository.findById(missedNormal.data.msgId));
  const storedQuestion = await components.messageRepository.findById(missedQuestion.data.msgId);
  assert.equal(storedQuestion.source, 'http_sweep');
  await waitUntil(async () => (await replyStatusOf(missedQuestion.data.msgId)) === 'sent');
  const thread = await components.threadRepository.findById(GROUP_ID);
  assert.equal(thread.name, 'Nhóm Tích Hợp');
});

test('gateway tạm dừng nhận outbox -> khởi động lại vẫn gửi nốt câu trả lời', { skip: !isEnabled }, async () => {
  await components.outboxConsumer.stop(); // giả lập gateway không nhận được thông báo outbox
  const message = makeGroupMessage({ text: '@Bot hỏi lúc gateway đang dừng', mentionsBot: true });
  await components.messageIngestor.ingest(message, BOT_UID, 'live');

  await waitUntil(async () => (await replyStatusOf(message.data.msgId)) === 'sending');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await components.outboxSender.sendStalePendingReplies(); // bộ đối soát của gateway

  assert.equal(await replyStatusOf(message.data.msgId), 'sent');
  await components.outboxConsumer.start();
});

test('ghi DB xong nhưng không báo được qua Redis -> agent-service tự đối soát và xử lý', { skip: !isEnabled }, async () => {
  const message = makeGroupMessage({ text: '@Bot tin không có thông báo Redis', mentionsBot: true });
  const { normalizeZaloMessage } = await import('../src/zalo/message-normalizer.js');
  const normalized = normalizeZaloMessage(message, BOT_UID, 'live');
  await components.messageRepository.insertIfAbsent(normalized);
  await components.replyJobRepository.createIfAbsent(normalized.msgId, normalized.threadId, normalized.threadType);

  await waitUntil(async () => (await replyStatusOf(normalized.msgId)) === 'sent', 90000);
});

test('tag quá cũ (bắt được khi bù tin sau sự cố dài) bị bỏ qua', { skip: !isEnabled }, async () => {
  const oldMessage = makeGroupMessage({
    text: '@Bot hỏi từ hôm qua',
    mentionsBot: true,
    timestamp: Date.now() - 24 * 3600 * 1000,
  });
  await components.messageIngestor.ingest(oldMessage, BOT_UID, 'http_sweep');
  assert.equal(await replyStatusOf(oldMessage.data.msgId), 'skipped');
});
