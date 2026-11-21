from datetime import datetime
from typing import Any

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    database: bool
    redis: bool
    gateway_connected: bool
    gateway: dict[str, Any] | None


class OutboxItemResponse(BaseModel):
    id: int
    kind: str
    chunk_index: int
    text: str
    status: str
    attempts: int
    zalo_msg_id: str | None
    error: str | None
    sent_at: datetime | None


class ReplyJobResponse(BaseModel):
    msg_id: str
    thread_id: str
    thread_type: str
    status: str
    attempts: int
    question: str | None
    answer: str | None
    error: str | None
    skip_reason: str | None
    openwebui_chat_id: str | None
    created_at: datetime
    updated_at: datetime


class ReplyJobDetailResponse(ReplyJobResponse):
    outbox: list[OutboxItemResponse]


class ReplyJobSummaryResponse(BaseModel):
    counts_by_status: dict[str, int]
    jobs: list[ReplyJobResponse]


class ThreadResponse(BaseModel):
    thread_id: str
    thread_type: str
    name: str | None
    last_ts: int | None
    last_swept_at: datetime | None
    message_count: int


class MessageResponse(BaseModel):
    msg_id: str
    sender_uid: str
    sender_name: str | None
    text: str | None
    ts: int
    is_self: bool
    triggers_bot: bool
    trigger_kind: str | None
    source: str
    received_at: datetime


class ActionResponse(BaseModel):
    ok: bool
    message: str
