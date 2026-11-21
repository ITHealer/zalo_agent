import { stripBotMention } from './zalo/normalize.js';

function hhmm(ts) {
  const d = new Date(Number(ts));
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

/**
 * Dựng messages gửi agent.
 * - Không ghi đè system prompt của agent (để nguyên cấu hình trên OpenWebUI).
 * - Vài lượt hỏi-đáp trước của bot trong nhóm -> các cặp user/assistant.
 * - Tin cuối (user) = ngữ cảnh nhóm gần đây + câu hỏi hiện tại.
 */
export function buildMessages({ trigger, botUid, groupName, contextRows, previousQa }) {
  const question = stripBotMention(trigger.text, trigger.mentions, botUid) || trigger.text || '';
  const lines = contextRows
    .filter((r) => r.msg_id !== trigger.msg_id)
    .map((r) => `[${hhmm(r.ts)}] ${r.is_self ? 'Bot' : r.sender_name || r.sender_uid}: ${(r.text || '').slice(0, 500)}`);

  let quoted = '';
  if (trigger.quote?.msg) {
    quoted = `\nTin nhắn đang được trả lời (quote): "${String(trigger.quote.msg).slice(0, 500)}"`;
  }

  const content = [
    `Bạn đang được hỏi trong nhóm Zalo${groupName ? ` "${groupName}"` : ''}.`,
    lines.length ? `Các tin nhắn gần đây trong nhóm (để hiểu ngữ cảnh, không cần trả lời từng tin):\n${lines.join('\n')}` : '',
    quoted,
    `\nNgười hỏi: ${trigger.sender_name || 'Thành viên'}`,
    `Câu hỏi: ${question || '(người dùng chỉ tag bot, không kèm nội dung - hãy chào và hỏi họ cần hỗ trợ gì)'}`,
    `\nTrả lời ngắn gọn, tự nhiên, bằng văn bản thuần (Zalo không hiển thị Markdown).`,
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [];
  for (const qa of previousQa) {
    messages.push({ role: 'user', content: qa.question });
    messages.push({ role: 'assistant', content: qa.answer });
  }
  messages.push({ role: 'user', content });
  return { messages, question };
}

/** Zalo không render Markdown -> làm sạch cơ bản. */
export function toPlainText(md) {
  return (md || '')
    .replace(/<details[\s\S]*?<\/details>/g, '') // khối tool-call/reasoning OpenWebUI có thể chèn
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Chia câu trả lời dài thành nhiều tin, ưu tiên cắt ở xuống dòng / dấu câu. */
export function chunkText(text, size) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('. ', size) + 1;
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
