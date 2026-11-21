import { Worker, UnrecoverableError } from 'bullmq';
import { ThreadType } from 'zca-js';
import { config } from './config.js';
import { logger } from './logger.js';
import { createRedis, QUEUE_NAME } from './queue.js';
import {
  getReplyJob,
  getMessage,
  updateReplyJob,
  getContextMessages,
  getRecentQa,
  getThread,
  insertMessage,
} from './db.js';
import { OpenWebUIClient } from './openwebui.js';
import { buildMessages, toPlainText, chunkText } from './prompt.js';
import { alert } from './alert.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * Math.max(0, b - a));

// Tuần tự hoá theo nhóm: 2 câu hỏi cùng nhóm không trả lời chen nhau
const threadChains = new Map();
function withThreadLock(threadId, fn) {
  const prev = threadChains.get(threadId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  threadChains.set(threadId, next);
  next.finally(() => {
    if (threadChains.get(threadId) === next) threadChains.delete(threadId);
  }).catch(() => {});
  return next;
}

function buildQuote(raw) {
  if (!raw) return undefined;
  return {
    content: raw.content,
    msgType: raw.msgType,
    propertyExt: raw.propertyExt,
    uidFrom: raw.uidFrom,
    msgId: raw.msgId,
    cliMsgId: raw.cliMsgId,
    ts: raw.ts,
    ttl: raw.ttl ?? 0,
  };
}

/**
 * @param {() => Promise<import('zca-js').API>} getZaloApi  trả về API Zalo đang đăng nhập (để gửi tin)
 * @param {() => string} getBotUid
 */
export function startReplyWorker(getZaloApi, getBotUid) {
  const owui = new OpenWebUIClient();

  async function processJob(job) {
    const { msgId } = job.data;
    const rj = await getReplyJob(msgId);
    if (!rj) throw new UnrecoverableError(`không có reply_job ${msgId}`);
    if (['sent', 'skipped'].includes(rj.status)) return { already: rj.status };

    const msg = await getMessage(msgId);
    if (!msg) throw new UnrecoverableError(`không có message ${msgId}`);
    const threadType = msg.thread_type === 'group' ? ThreadType.Group : ThreadType.User;

    return withThreadLock(msg.thread_id, async () => {
      const api = await getZaloApi();
      const botUid = getBotUid();
      let answer = rj.answer;

      // 1) Hỏi agent (bỏ qua nếu lần trước đã có câu trả lời nhưng gửi lỗi -> không gọi lại LLM)
      if (!answer) {
        await updateReplyJob(msgId, { status: 'processing', attempts: rj.attempts + 1 });
        api.sendTypingEvent(msg.thread_id, threadType).catch(() => {});
        const thread = await getThread(msg.thread_id);
        const contextRows = await getContextMessages(msg.thread_id, msg.ts, config.reply.contextMessages);
        const previousQa = await getRecentQa(msg.thread_id, msgId, config.openwebui.historyTurns);
        const { messages, question } = buildMessages({
          trigger: msg,
          botUid,
          groupName: thread?.name,
          contextRows,
          previousQa,
        });
        const res = await owui.ask({ threadId: msg.thread_id, threadTitle: thread?.name, messages });
        answer = toPlainText(res.text);
        await updateReplyJob(msgId, {
          status: 'answered',
          question,
          answer,
          openwebui_chat_id: res.chatId || null,
          openwebui_message_id: res.messageId || null,
          error: null,
        });
      }
      if (!answer) {
        await updateReplyJob(msgId, { status: 'skipped', skip_reason: 'empty_answer' });
        return { skipped: 'empty_answer' };
      }

      // 2) Gửi về Zalo (giả lập người thật: chờ + typing), resume được nếu lỗi giữa chừng
      const chunks = chunkText(answer, config.reply.chunkSize);
      const sent = Array.isArray(rj.sent_msg_ids) ? [...rj.sent_msg_ids] : [];
      for (let i = sent.length; i < chunks.length; i++) {
        api.sendTypingEvent(msg.thread_id, threadType).catch(() => {});
        await sleep(rand(config.reply.delayMinMs, config.reply.delayMaxMs));
        let text = chunks[i];
        const payload = { msg: text };
        if (i === 0) {
          payload.quote = buildQuote(msg.raw);
          if (config.reply.mentionSender && threadType === ThreadType.Group && msg.sender_name) {
            const tag = `@${msg.sender_name}`;
            text = `${tag} ${text}`;
            payload.msg = text;
            payload.mentions = [{ pos: 0, uid: msg.sender_uid, len: tag.length }];
          }
        }
        const r = await api.sendMessage(payload, msg.thread_id, threadType);
        const sentId = r?.message?.msgId != null ? String(r.message.msgId) : null;
        sent.push(sentId);
        await updateReplyJob(msgId, { sent_msg_ids: sent });
        if (sentId) {
          await insertMessage({
            msgId: sentId,
            cliMsgId: null,
            threadId: msg.thread_id,
            threadType: msg.thread_type,
            senderUid: botUid,
            senderName: 'Bot',
            msgType: 'webchat',
            text,
            content: text,
            mentions: payload.mentions || null,
            quote: null,
            ts: Date.now(),
            isSelf: true,
            triggersBot: false,
            source: 'self_sent',
            raw: null,
          }).catch(() => {});
        }
      }
      await updateReplyJob(msgId, { status: 'sent', error: null });
      logger.info({ msgId, threadId: msg.thread_id, chunks: chunks.length }, 'đã trả lời trên Zalo');
      return { sent: sent.length };
    });
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      try {
        return await processJob(job);
      } catch (err) {
        await updateReplyJob(job.data.msgId, { error: String(err.message || err).slice(0, 2000) }).catch(() => {});
        if (err.retryable === false) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    {
      connection: createRedis(),
      concurrency: config.reply.concurrency,
      limiter: { max: config.reply.rateMax, duration: config.reply.rateDurationMs },
      lockDuration: Math.max(60000, config.openwebui.timeoutMs + 60000),
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts || 1) || err instanceof UnrecoverableError || err?.name === 'UnrecoverableError';
    logger.error({ msgId: job.data.msgId, attempt: job.attemptsMade, final, err: err.message }, 'trả lời thất bại');
    if (!final) return;
    await updateReplyJob(job.data.msgId, { status: 'failed' }).catch(() => {});
    await alert('Bot không trả lời được 1 tin nhắn', `msgId=${job.data.msgId}: ${err.message}`);
    if (config.reply.fallbackText) {
      try {
        const msg = await getMessage(job.data.msgId);
        const api = await getZaloApi();
        await api.sendMessage(
          { msg: config.reply.fallbackText, quote: buildQuote(msg.raw) },
          msg.thread_id,
          msg.thread_type === 'group' ? ThreadType.Group : ThreadType.User,
        );
      } catch (e) {
        logger.warn({ err: e.message }, 'gửi fallback lỗi');
      }
    }
  });
  worker.on('error', (err) => logger.error({ err: err.message }, 'worker error'));
  logger.info({ concurrency: config.reply.concurrency, mode: config.openwebui.mode }, 'reply worker đã chạy');
  return worker;
}
