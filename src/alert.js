import { config } from './config.js';
import { logger } from './logger.js';

const lastSent = new Map();

/**
 * Gửi cảnh báo tới webhook (Slack/Google Chat/Teams/Telegram-proxy... đều nhận JSON {text}).
 * Có chống spam: cùng tiêu đề chỉ gửi lại sau 10 phút.
 */
export async function alert(title, detail = '') {
  logger.warn({ alert: title, detail }, 'ALERT');
  if (!config.alertWebhookUrl) return;
  const now = Date.now();
  if (now - (lastSent.get(title) || 0) < 10 * 60 * 1000) return;
  lastSent.set(title, now);
  try {
    await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[zalo-agent] ${title}${detail ? `\n${detail}` : ''}` }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'gửi alert thất bại');
  }
}
