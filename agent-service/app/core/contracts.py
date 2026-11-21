"""Hợp đồng giao tiếp với zalo-gateway (Node).

Mọi thay đổi ở đây phải sửa tương ứng trong zalo-gateway/src/contracts.js
"""

from enum import StrEnum


class Streams(StrEnum):
    # gateway -> agent-service: "có tin cần trả lời", payload {"msg_id": ...}
    REPLY_REQUESTS = "zalo:reply-requests"
    # agent-service -> gateway: "có câu trả lời cần gửi", payload {"reply_msg_id": ...}
    OUTBOX = "zalo:outbox"


class ConsumerGroups(StrEnum):
    AGENT_SERVICE = "agent-service"
    GATEWAY = "zalo-gateway"


class RedisKeys(StrEnum):
    GATEWAY_STATUS = "zalo:gateway:status"
    GATEWAY_QR = "zalo:gateway:qr"


class ReplyStatus(StrEnum):
    QUEUED = "queued"
    PROCESSING = "processing"
    ANSWERED = "answered"
    SENDING = "sending"
    SENT = "sent"
    SKIPPED = "skipped"
    FAILED = "failed"


class OutboxKind(StrEnum):
    ANSWER = "answer"
    FALLBACK = "fallback"
