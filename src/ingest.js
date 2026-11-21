import { config } from './config.js';
import { logger } from './logger.js';
import { insertMessage, upsertThreadCursor, createReplyJob, updateReplyJob } from './db.js';
import { normalizeMessage } from './zalo/normalize.js';
import { enqueueReply } from './queue.js';

function shouldStore(m) {
  if (m.threadType === 'user') return config.zalo.storeDirectMessages;
  const allow = config.zalo.storeGroupAllowlist;
  return !allow.length || allow.includes(m.threadId);
}

function canReplyIn(m) {
  if (m.threadType === 'user') return config.zalo.replyToDirectMessages;
  const allow = config.zalo.replyGroupAllowlist;
  return !allow.length || allow.includes(m.threadId);
}

export const ingestStats = { live: 0, ws_backfill: 0, http_sweep: 0, duplicates: 0, triggers: 0 };

/**
 * Lưu 1 tin (idempotent). Nếu là tin mới & gọi bot -> tạo reply job + enqueue.
 * Thứ tự: ghi DB trước, enqueue sau. Nếu chết giữa chừng, reconcilePendingJobs() sẽ enqueue lại.
 */
export async function ingest(message, botUid, source) {
  const m = normalizeMessage(message, botUid, source, {
    replyOnQuoteToBot: config.zalo.replyOnQuoteToBot,
    replyOnMentionAll: config.zalo.replyOnMentionAll,
    triggerKeywords: config.zalo.triggerKeywords,
  });
  if (!m.msgId || !Number.isFinite(m.ts)) return { stored: false };
  if (!shouldStore(m)) return { stored: false };

  // DM: chỉ nhắn riêng với bot thì luôn coi là "gọi bot" (nếu bật trả lời DM)
  if (m.threadType === 'user' && !m.isSelf && config.zalo.replyToDirectMessages) {
    m.triggersBot = true;
    m.trigger = m.trigger || 'direct';
  }

  const isNew = await insertMessage(m);
  if (!isNew) {
    ingestStats.duplicates++;
    return { stored: false, duplicate: true };
  }
  ingestStats[source] = (ingestStats[source] || 0) + 1;
  await upsertThreadCursor(m.threadId, m.threadType, m.msgId, m.ts);

  if (m.triggersBot && canReplyIn(m)) {
    ingestStats.triggers++;
    const created = await createReplyJob(m.msgId, m.threadId);
    if (created) {
      const age = Date.now() - m.ts;
      if (age > config.reliability.replyMaxAgeMs) {
        await updateReplyJob(m.msgId, { status: 'skipped', skip_reason: `stale:${Math.round(age / 1000)}s` });
        logger.warn({ msgId: m.msgId, threadId: m.threadId, ageSec: Math.round(age / 1000) }, 'tag quá cũ, bỏ qua trả lời');
      } else {
        await enqueueReply(m.msgId);
        logger.info({ msgId: m.msgId, threadId: m.threadId, trigger: m.trigger, source }, 'bot được gọi -> đã xếp hàng trả lời');
      }
    }
  }
  return { stored: true, triggersBot: m.triggersBot };
}
