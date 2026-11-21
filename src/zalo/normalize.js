// Chuyển message của zca-js (UserMessage/GroupMessage) thành bản ghi chuẩn + xác định có "gọi" bot không.

/** Rút text đọc được từ content (string hoặc object đính kèm). */
export function extractText(content, msgType) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const parts = [];
  if (content.title) parts.push(String(content.title));
  if (content.description) parts.push(String(content.description));
  if (content.href && !parts.length) parts.push(String(content.href));
  const text = parts.join(' - ');
  const kind = (msgType || '').replace(/^chat\./, '');
  return kind && kind !== 'webchat' ? `[${kind}] ${text}`.trim() : text;
}

/**
 * Bot có bị gọi không?
 * - @tag đúng uid bot
 * - reply (quote) vào tin của bot
 * - @All (tuỳ chọn)
 * - từ khoá kích hoạt (tuỳ chọn)
 */
export function detectTrigger({ mentions, quote, text }, botUid, opts = {}) {
  const ms = Array.isArray(mentions) ? mentions : [];
  if (botUid && ms.some((m) => String(m.uid) === String(botUid))) return 'mention';
  if (opts.replyOnMentionAll && ms.some((m) => m.type === 1 || String(m.uid) === '-1')) return 'mention_all';
  if (opts.replyOnQuoteToBot && botUid && quote && String(quote.ownerId) === String(botUid)) return 'quote';
  const lower = (text || '').toLowerCase();
  if (opts.triggerKeywords?.length && opts.triggerKeywords.some((k) => lower.includes(k))) return 'keyword';
  return null;
}

/** Bỏ đoạn "@Tên Bot" khỏi câu hỏi dựa trên vị trí mention. */
export function stripBotMention(text, mentions, botUid) {
  if (!text) return '';
  const ranges = (Array.isArray(mentions) ? mentions : [])
    .filter((m) => String(m.uid) === String(botUid) && Number.isInteger(m.pos) && m.len > 0)
    .sort((a, b) => b.pos - a.pos);
  let out = text;
  for (const r of ranges) out = out.slice(0, r.pos) + out.slice(r.pos + r.len);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * @param {import('zca-js').UserMessage|import('zca-js').GroupMessage} message
 * @param {string} botUid
 * @param {string} source
 */
export function normalizeMessage(message, botUid, source, triggerOpts = {}) {
  const d = message.data;
  const threadType = message.type === 1 ? 'group' : 'user'; // ThreadType.Group = 1
  const text = extractText(d.content, d.msgType);
  const mentions = d.mentions || null;
  const quote = d.quote || null;
  const trigger = message.isSelf ? null : detectTrigger({ mentions, quote, text }, botUid, triggerOpts);
  return {
    msgId: String(d.msgId),
    cliMsgId: d.cliMsgId != null ? String(d.cliMsgId) : null,
    threadId: String(message.threadId),
    threadType,
    senderUid: String(d.uidFrom),
    senderName: d.dName || null,
    msgType: d.msgType || null,
    text,
    content: d.content,
    mentions,
    quote,
    ts: Number(d.ts),
    isSelf: Boolean(message.isSelf),
    trigger,
    triggersBot: Boolean(trigger),
    source,
    raw: d,
  };
}

/** So sánh msgId (chuỗi số lớn, tăng dần theo thời gian). */
export function msgIdLte(a, b) {
  try {
    return BigInt(a) <= BigInt(b);
  } catch {
    return String(a) <= String(b);
  }
}
