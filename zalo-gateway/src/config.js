import 'dotenv/config';

function readString(name, defaultValue = undefined) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value;
}

function readNumber(name, defaultValue) {
  const value = readString(name);
  if (value === undefined) {
    return defaultValue;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Biến môi trường ${name} phải là số, đang là "${value}"`);
  }
  return number;
}

function readBoolean(name, defaultValue) {
  const value = readString(name);
  if (value === undefined) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readList(name) {
  const value = readString(name, '');
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export const config = {
  logLevel: readString('LOG_LEVEL', 'info'),
  httpPort: readNumber('GATEWAY_HTTP_PORT', 3000),
  dataDir: readString('DATA_DIR', './data'),
  databaseUrl: readString('DATABASE_URL', 'postgres://zalo:zalo@localhost:5432/zalo_agent'),
  redisUrl: readString('REDIS_URL', 'redis://localhost:6379'),
  alertWebhookUrl: readString('ALERT_WEBHOOK_URL', ''),

  zalo: {
    // Định danh tài khoản bot: dùng làm khoá lưu session và khoá listener
    accountKey: readString('ZALO_ACCOUNT_KEY', 'default'),
    userAgent: readString(
      'ZALO_USER_AGENT',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    ),
  },

  trigger: {
    // Chỉ trả lời trong các nhóm này. Để trống = mọi nhóm bot tham gia.
    replyGroupAllowlist: readList('REPLY_GROUP_ALLOWLIST'),
    replyToDirectMessages: readBoolean('REPLY_TO_DIRECT_MESSAGES', false),
    replyOnQuoteToBot: readBoolean('REPLY_ON_QUOTE_TO_BOT', true),
    replyOnMentionAll: readBoolean('REPLY_ON_MENTION_ALL', false),
    keywords: readList('TRIGGER_KEYWORDS').map((keyword) => keyword.toLowerCase()),
    // Tag cũ hơn ngưỡng này (bắt được khi bù tin sau sự cố dài) sẽ không được trả lời
    maxMessageAgeMs: readNumber('REPLY_MAX_AGE_MS', 60 * 60 * 1000),
  },

  storage: {
    // Chỉ lưu tin của các nhóm này. Để trống = lưu mọi nhóm.
    groupAllowlist: readList('STORE_GROUP_ALLOWLIST'),
    storeDirectMessages: readBoolean('STORE_DIRECT_MESSAGES', true),
  },

  connection: {
    reconnectMinDelayMs: readNumber('RECONNECT_MIN_MS', 2000),
    reconnectMaxDelayMs: readNumber('RECONNECT_MAX_MS', 60000),
    // Bị đá do có phiên Zalo Web/PC khác (mã 3000/3003): chờ lâu hơn rồi mới giành lại
    duplicateConnectionDelayMs: readNumber('DUPLICATE_CONNECTION_BACKOFF_MS', 120000),
    pingIntervalMs: readNumber('WS_PING_INTERVAL_MS', 30000),
    pongTimeoutMs: readNumber('WS_PONG_TIMEOUT_MS', 15000),
    // Không nhận được gì trong khoảng này (khi server không hỗ trợ pong) -> kết nối lại
    idleReconnectMs: readNumber('IDLE_RECONNECT_MS', 15 * 60 * 1000),
    sessionCheckIntervalMs: readNumber('SESSION_CHECK_INTERVAL_MS', 10 * 60 * 1000),
    listenerLockTtlMs: readNumber('LISTENER_LOCK_TTL_MS', 30000),
  },

  sweep: {
    // Quét bù định kỳ mọi nhóm qua HTTP: lưới an toàn chống sót tin
    intervalMs: readNumber('SWEEP_INTERVAL_MS', 5 * 60 * 1000),
    maxPagesPerGroup: readNumber('SWEEP_MAX_PAGES_PER_GROUP', 6),
    delayBetweenGroupsMs: readNumber('SWEEP_DELAY_BETWEEN_GROUPS_MS', 1500),
  },

  sending: {
    // Giả lập người thật: chờ ngẫu nhiên trước mỗi tin gửi đi
    delayMinMs: readNumber('REPLY_DELAY_MIN_MS', 1500),
    delayMaxMs: readNumber('REPLY_DELAY_MAX_MS', 4000),
    // Khoảng cách tối thiểu giữa 2 tin gửi đi (toàn bộ tài khoản) để tránh bị Zalo hạn chế
    minIntervalBetweenSendsMs: readNumber('SEND_MIN_INTERVAL_MS', 1000),
    maxAttempts: readNumber('SEND_MAX_ATTEMPTS', 5),
    reconcileIntervalMs: readNumber('OUTBOX_RECONCILE_INTERVAL_MS', 60000),
  },
};
