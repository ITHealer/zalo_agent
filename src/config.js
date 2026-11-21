import 'dotenv/config';

function str(name, def = undefined) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function int(name, def) {
  const v = str(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Biến môi trường ${name} phải là số, đang là "${v}"`);
  return n;
}
function bool(name, def) {
  const v = str(name);
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function list(name) {
  const v = str(name, '');
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  role: str('ROLE', 'all'), // all | listener | worker
  logLevel: str('LOG_LEVEL', 'info'),
  httpPort: int('HTTP_PORT', 3000),
  dataDir: str('DATA_DIR', './data'),

  databaseUrl: str('DATABASE_URL', 'postgres://zalo:zalo@localhost:5432/zalo_agent'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),

  zalo: {
    // Tên định danh tài khoản bot (dùng làm khoá lưu session + lock), đổi nếu chạy nhiều số
    accountKey: str('ZALO_ACCOUNT_KEY', 'default'),
    userAgent: str(
      'ZALO_USER_AGENT',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    ),
    // Chỉ trả lời trong các nhóm này (id, phân cách dấu phẩy). Để trống = mọi nhóm bot tham gia.
    replyGroupAllowlist: list('REPLY_GROUP_ALLOWLIST'),
    // Lưu tin của các nhóm này. Để trống = lưu mọi nhóm.
    storeGroupAllowlist: list('STORE_GROUP_ALLOWLIST'),
    storeDirectMessages: bool('STORE_DIRECT_MESSAGES', true),
    replyToDirectMessages: bool('REPLY_TO_DIRECT_MESSAGES', false),
    replyOnQuoteToBot: bool('REPLY_ON_QUOTE_TO_BOT', true),
    replyOnMentionAll: bool('REPLY_ON_MENTION_ALL', false),
    // Từ khoá kích hoạt thêm (ngoài @tag), ví dụ "/bot,#hoi". Không phân biệt hoa thường.
    triggerKeywords: list('TRIGGER_KEYWORDS').map((k) => k.toLowerCase()),
  },

  reliability: {
    reconnectMinMs: int('RECONNECT_MIN_MS', 2000),
    reconnectMaxMs: int('RECONNECT_MAX_MS', 60000),
    // Bị đá do có phiên Zalo Web khác (mã 3000/3003): chờ lâu hơn trước khi giành lại
    duplicateConnectionBackoffMs: int('DUPLICATE_CONNECTION_BACKOFF_MS', 120000),
    pingIntervalMs: int('WS_PING_INTERVAL_MS', 30000),
    pongTimeoutMs: int('WS_PONG_TIMEOUT_MS', 15000),
    // Không có sự kiện nào trong khoảng này -> chủ động kết nối lại + backfill
    idleReconnectMs: int('IDLE_RECONNECT_MS', 15 * 60 * 1000),
    // Quét bù định kỳ mọi nhóm qua HTTP (lưới an toàn chống miss tin)
    sweepIntervalMs: int('SWEEP_INTERVAL_MS', 5 * 60 * 1000),
    sweepMaxPagesPerGroup: int('SWEEP_MAX_PAGES_PER_GROUP', 6),
    sweepDelayBetweenGroupsMs: int('SWEEP_DELAY_BETWEEN_GROUPS_MS', 1500),
    // Kiểm tra phiên đăng nhập còn sống
    sessionCheckIntervalMs: int('SESSION_CHECK_INTERVAL_MS', 10 * 60 * 1000),
    // Tin bị tag nhưng quá cũ (vd bắt được khi backfill sau sự cố dài) -> không trả lời
    replyMaxAgeMs: int('REPLY_MAX_AGE_MS', 60 * 60 * 1000),
    listenerLockTtlMs: int('LISTENER_LOCK_TTL_MS', 30000),
  },

  reply: {
    concurrency: int('REPLY_CONCURRENCY', 3),
    rateMax: int('REPLY_RATE_MAX', 20), // tối đa N tin trả lời...
    rateDurationMs: int('REPLY_RATE_DURATION_MS', 60000), // ...trong khoảng này
    delayMinMs: int('REPLY_DELAY_MIN_MS', 1500),
    delayMaxMs: int('REPLY_DELAY_MAX_MS', 4000),
    contextMessages: int('CONTEXT_MESSAGES', 30),
    maxAttempts: int('REPLY_MAX_ATTEMPTS', 4),
    chunkSize: int('REPLY_CHUNK_SIZE', 1800),
    mentionSender: bool('REPLY_MENTION_SENDER', true),
    fallbackText: str('REPLY_FALLBACK_TEXT', ''),
  },

  openwebui: {
    baseUrl: (str('OPENWEBUI_URL', 'http://localhost:8080') || '').replace(/\/+$/, ''),
    apiKey: str('OPENWEBUI_API_KEY', ''),
    model: str('OPENWEBUI_MODEL', ''),
    // chat (mặc định, chạy tool phía server) | completions (OpenAI-compatible đơn giản)
    mode: str('OPENWEBUI_MODE', 'chat'),
    // Bỏ trống = tự lấy toolIds đã gắn trên agent. "none" = không truyền tool nào.
    toolIds: list('OPENWEBUI_TOOL_IDS'),
    // Bật builtin tools (cần để agent tra Knowledge Base gắn trên model ở function calling native)
    enableBuiltinTools: bool('OPENWEBUI_ENABLE_BUILTIN_TOOLS', true),
    timeoutMs: int('OPENWEBUI_TIMEOUT_MS', 180000),
    pollIntervalMs: int('OPENWEBUI_POLL_INTERVAL_MS', 1500),
    // Đổi chat OpenWebUI theo ngày cho mỗi nhóm để chat không phình quá to
    rotateChatDaily: bool('OPENWEBUI_ROTATE_CHAT_DAILY', true),
    historyTurns: int('OPENWEBUI_HISTORY_TURNS', 4),
  },

  alertWebhookUrl: str('ALERT_WEBHOOK_URL', ''),
};

export function assertConfig(role) {
  const errs = [];
  if (role !== 'listener') {
    if (!config.openwebui.apiKey) errs.push('OPENWEBUI_API_KEY');
    if (!config.openwebui.model) errs.push('OPENWEBUI_MODEL');
  }
  if (errs.length) throw new Error(`Thiếu biến môi trường: ${errs.join(', ')}`);
  if (!['chat', 'completions'].includes(config.openwebui.mode)) {
    throw new Error('OPENWEBUI_MODE chỉ nhận "chat" hoặc "completions"');
  }
}
