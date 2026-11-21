// Chuyển message của zca-js (UserMessage / GroupMessage) thành bản ghi chuẩn
// và xác định tin đó có "gọi" bot hay không. Các hàm ở đây là hàm thuần (không I/O) để dễ test.

const ZALO_THREAD_TYPE_GROUP = 1; // ThreadType.Group trong zca-js
const MENTION_TYPE_ALL = 1; // @All

/** Rút phần chữ đọc được từ content (chuỗi, hoặc object khi là file/link/ảnh). */
export function extractReadableText(content, msgType) {
  if (typeof content === 'string') {
    return content;
  }
  if (!content || typeof content !== 'object') {
    return '';
  }

  const parts = [];
  if (content.title) {
    parts.push(String(content.title));
  }
  if (content.description) {
    parts.push(String(content.description));
  }
  if (content.href && parts.length === 0) {
    parts.push(String(content.href));
  }
  const text = parts.join(' - ');

  const messageKind = (msgType || '').replace(/^chat\./, '');
  if (messageKind && messageKind !== 'webchat') {
    return `[${messageKind}] ${text}`.trim();
  }
  return text;
}

/**
 * Xác định cách bot được gọi. Trả về null nếu không gọi bot.
 *  - "mention":     @tag đúng bot
 *  - "mention_all": @All (nếu bật)
 *  - "quote":       reply vào tin của bot (nếu bật)
 *  - "keyword":     chứa từ khoá kích hoạt (nếu cấu hình)
 */
export function detectTriggerKind({ mentions, quote, text }, botUid, options = {}) {
  const mentionList = Array.isArray(mentions) ? mentions : [];

  const mentionsBot = mentionList.some((mention) => String(mention.uid) === String(botUid));
  if (botUid && mentionsBot) {
    return 'mention';
  }

  const mentionsAll = mentionList.some((mention) => mention.type === MENTION_TYPE_ALL || String(mention.uid) === '-1');
  if (options.replyOnMentionAll && mentionsAll) {
    return 'mention_all';
  }

  const quotesBot = quote && String(quote.ownerId) === String(botUid);
  if (options.replyOnQuoteToBot && botUid && quotesBot) {
    return 'quote';
  }

  const keywords = options.keywords || [];
  const lowerText = (text || '').toLowerCase();
  if (keywords.some((keyword) => lowerText.includes(keyword))) {
    return 'keyword';
  }

  return null;
}

/** So sánh msgId của Zalo (chuỗi số rất lớn, tăng dần theo thời gian): a <= b ? */
export function isMessageIdLessOrEqual(firstId, secondId) {
  try {
    return BigInt(firstId) <= BigInt(secondId);
  } catch {
    return String(firstId) <= String(secondId);
  }
}

/**
 * @param {object} zaloMessage  UserMessage | GroupMessage của zca-js
 * @param {string} botUid
 * @param {string} source       live | ws_backfill | http_sweep
 * @param {object} triggerOptions
 */
export function normalizeZaloMessage(zaloMessage, botUid, source, triggerOptions = {}) {
  const data = zaloMessage.data;
  const text = extractReadableText(data.content, data.msgType);
  const mentions = data.mentions || null;
  const quote = data.quote || null;

  let triggerKind = null;
  if (!zaloMessage.isSelf) {
    triggerKind = detectTriggerKind({ mentions, quote, text }, botUid, triggerOptions);
  }

  return {
    msgId: String(data.msgId),
    cliMsgId: data.cliMsgId != null ? String(data.cliMsgId) : null,
    threadId: String(zaloMessage.threadId),
    threadType: zaloMessage.type === ZALO_THREAD_TYPE_GROUP ? 'group' : 'user',
    senderUid: String(data.uidFrom),
    senderName: data.dName || null,
    msgType: data.msgType || null,
    text,
    content: data.content,
    mentions,
    quote,
    timestamp: Number(data.ts),
    isSelf: Boolean(zaloMessage.isSelf),
    triggerKind,
    triggersBot: triggerKind !== null,
    source,
    raw: data,
  };
}
