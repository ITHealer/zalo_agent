// Test end-to-end với Zalo giả lập + Postgres/Redis/OpenWebUI thật.
// Chạy: E2E=1 OPENWEBUI_URL=... OPENWEBUI_API_KEY=... OPENWEBUI_MODEL=... node --test --test-force-exit test/e2e.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.E2E === '1';
process.env.LOG_LEVEL ||= 'warn';
process.env.REPLY_DELAY_MIN_MS = '10';
process.env.REPLY_DELAY_MAX_MS = '20';
process.env.SWEEP_DELAY_BETWEEN_GROUPS_MS = '10';
process.env.ZALO_ACCOUNT_KEY = 'e2e';

const BOT = '1000';
const GROUP = 'g-e2e-' + Date.now();
let seq = BigInt(Date.now()) * 1000n;
const nextId = () => String(++seq);

let mods;
const sent = [];
let cloudMessages = [];

function groupMsg(GroupMessage, { text, mentionBot = false, uidFrom = '2000', ts = Date.now(), msgId = nextId() }) {
  return new GroupMessage(BOT, {
    msgId,
    cliMsgId: msgId,
    msgType: 'webchat',
    uidFrom,
    idTo: GROUP,
    dName: 'Khách Test',
    ts: String(ts),
    content: text,
    mentions: mentionBot ? [{ uid: BOT, pos: 0, len: 4, type: 0 }] : undefined,
    ttl: 0,
  });
}

const mockApi = {
  getOwnId: () => BOT,
  sendTypingEvent: async () => ({ status: 1 }),
  sendMessage: async (payload, threadId, type) => {
    const id = nextId();
    sent.push({ payload, threadId, type, id });
    return { message: { msgId: Number(id) }, attachment: [] };
  },
  getAllGroups: async () => ({ gridVerMap: { [GROUP]: '1' } }),
  getGroupInfo: async () => ({ gridInfoMap: { [GROUP]: { name: 'Nhóm E2E' } } }),
  getCloudMessage: async () => ({ groupMsgs: cloudMessages, hasMore: 0, isOld: 0, lastMsgId: '0' }),
};

async function waitFor(fn, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
}

before(async () => {
  if (!enabled) return;
  const db = await import('../src/db.js');
  await db.migrate();
  const { ingest } = await import('../src/ingest.js');
  const { startReplyWorker } = await import('../src/worker.js');
  const { ZaloConnection } = await import('../src/zalo/connection.js');
  const { GroupMessage } = await import('zca-js');
  const queue = await import('../src/queue.js');
  const worker = startReplyWorker(async () => mockApi, () => BOT);
  mods = { db, ingest, ZaloConnection, GroupMessage, worker, queue };
});

after(async () => {
  if (!enabled) return;
  await mods.worker.close();
  await mods.queue.replyQueue.close();
  await mods.queue.redis.quit();
  await mods.db.pool.end();
});

const jobStatus = async (msgId) => (await mods.db.getReplyJob(msgId))?.status;

test('tin thường: chỉ lưu, không trả lời', { skip: !enabled }, async () => {
  const m = groupMsg(mods.GroupMessage, { text: 'Chào cả nhà, tour Đà Lạt tháng 12 còn chỗ không?' });
  const r = await mods.ingest(m, BOT, 'live');
  assert.equal(r.stored, true);
  assert.equal(r.triggersBot, false);
  assert.equal(await mods.db.getReplyJob(m.data.msgId), null);
});

test('tin tag bot: agent trả lời, gửi lại nhóm kèm quote + mention', { skip: !enabled }, async () => {
  const m = groupMsg(mods.GroupMessage, { text: '@Bot giá tour Nha Trang?', mentionBot: true });
  await mods.ingest(m, BOT, 'live');
  await waitFor(async () => (await jobStatus(m.data.msgId)) === 'sent');
  const out = sent.find((s) => s.payload.quote?.msgId === m.data.msgId);
  assert.ok(out, 'phải gửi trả lời có quote tin gốc');
  assert.equal(out.threadId, GROUP);
  assert.match(out.payload.msg, /^@Khách Test /);
  assert.deepEqual(out.payload.mentions[0], { pos: 0, uid: '2000', len: '@Khách Test'.length });
  const job = await mods.db.getReplyJob(m.data.msgId);
  assert.ok(job.answer.length > 0);
  assert.ok(job.openwebui_chat_id || process.env.OPENWEBUI_MODE === 'completions');
  console.log('   agent answer:', job.answer.slice(0, 120));
});

test('nhận trùng (live + backfill) không trả lời 2 lần', { skip: !enabled }, async () => {
  const m = groupMsg(mods.GroupMessage, { text: '@Bot còn tour Phú Quốc?', mentionBot: true });
  await mods.ingest(m, BOT, 'live');
  const again = await mods.ingest(m, BOT, 'ws_backfill');
  assert.equal(again.duplicate, true);
  await waitFor(async () => (await jobStatus(m.data.msgId)) === 'sent');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sent.filter((s) => s.payload.quote?.msgId === m.data.msgId).length, 1);
});

test('tin bị rớt khỏi WebSocket được quét bù (HTTP sweep) và vẫn được trả lời', { skip: !enabled }, async () => {
  const missed = groupMsg(mods.GroupMessage, { text: '@Bot tin này không qua websocket', mentionBot: true });
  const normal = groupMsg(mods.GroupMessage, { text: 'tin thường bị rớt' });
  cloudMessages = [missed, normal];
  const conn = new mods.ZaloConnection();
  conn.api = mockApi;
  conn.botUid = BOT;
  await conn.sweep();
  assert.ok(await mods.db.getMessage(normal.data.msgId), 'tin thường phải được lưu');
  const row = await mods.db.getMessage(missed.data.msgId);
  assert.equal(row.source, 'http_sweep');
  await waitFor(async () => (await jobStatus(missed.data.msgId)) === 'sent');
  const thread = await mods.db.getThread(GROUP);
  assert.equal(thread.name, 'Nhóm E2E');
});

test('tag quá cũ (bắt được khi backfill sau sự cố dài) thì bỏ qua', { skip: !enabled }, async () => {
  const old = groupMsg(mods.GroupMessage, { text: '@Bot hỏi từ hôm qua', mentionBot: true, ts: Date.now() - 24 * 3600 * 1000 });
  await mods.ingest(old, BOT, 'http_sweep');
  assert.equal(await jobStatus(old.data.msgId), 'skipped');
});

test('tin do chính bot gửi không kích hoạt bot', { skip: !enabled }, async () => {
  const self = groupMsg(mods.GroupMessage, { text: '@Bot tự tag', mentionBot: true, uidFrom: '0' });
  const r = await mods.ingest(self, BOT, 'live');
  assert.equal(r.triggersBot, false);
});
