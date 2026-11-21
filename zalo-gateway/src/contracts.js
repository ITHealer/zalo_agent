// Hợp đồng giao tiếp với agent-service (Python).
// Mọi thay đổi ở đây phải sửa tương ứng trong agent-service/app/core/contracts.py

export const STREAMS = {
  // gateway -> agent-service: "có tin cần trả lời", payload { msg_id }
  replyRequests: 'zalo:reply-requests',
  // agent-service -> gateway: "có câu trả lời cần gửi", payload { reply_msg_id }
  outbox: 'zalo:outbox',
};

export const CONSUMER_GROUPS = {
  agentService: 'agent-service',
  gateway: 'zalo-gateway',
};

export const REDIS_KEYS = {
  gatewayStatus: 'zalo:gateway:status', // JSON trạng thái kết nối, gia hạn mỗi 10s
  gatewayQr: 'zalo:gateway:qr', // JSON { image, status, generated_at } khi cần quét QR
  listenerLockPrefix: 'zalo:gateway:listener-lock:',
};

export const REPLY_STATUS = {
  queued: 'queued',
  processing: 'processing',
  answered: 'answered',
  sending: 'sending',
  sent: 'sent',
  skipped: 'skipped',
  failed: 'failed',
};

export const OUTBOX_STATUS = {
  pending: 'pending',
  sent: 'sent',
  failed: 'failed',
};
