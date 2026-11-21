import { config } from '../config.js';
import { logger } from '../logger.js';

const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const lastSentAtByTitle = new Map();

/**
 * Gửi cảnh báo tới webhook (Slack / Google Chat / Teams đều nhận JSON {text}).
 * Cùng một tiêu đề chỉ gửi lại sau 10 phút để tránh spam.
 */
export async function sendAlert(title, detail = '') {
  logger.warn({ alert: title, detail }, 'ALERT');
  if (!config.alertWebhookUrl) {
    return;
  }
  const now = Date.now();
  const lastSentAt = lastSentAtByTitle.get(title) || 0;
  if (now - lastSentAt < ALERT_COOLDOWN_MS) {
    return;
  }
  lastSentAtByTitle.set(title, now);

  const text = detail ? `[zalo-gateway] ${title}\n${detail}` : `[zalo-gateway] ${title}`;
  try {
    await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    logger.warn({ err: error.message }, 'Gửi cảnh báo thất bại');
  }
}
