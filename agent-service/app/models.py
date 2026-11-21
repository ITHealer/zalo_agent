"""Các đối tượng dữ liệu dùng trong service (ánh xạ từ bảng Postgres)."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import asyncpg


@dataclass(frozen=True)
class StoredMessage:
    msg_id: str
    thread_id: str
    thread_type: str
    sender_uid: str
    sender_name: str | None
    text: str | None
    mentions: list[dict[str, Any]] | None
    quote: dict[str, Any] | None
    timestamp_ms: int
    is_self: bool

    @classmethod
    def from_record(cls, record: asyncpg.Record) -> "StoredMessage":
        return cls(
            msg_id=record["msg_id"],
            thread_id=record["thread_id"],
            thread_type=record["thread_type"],
            sender_uid=record["sender_uid"],
            sender_name=record["sender_name"],
            text=record["text"],
            mentions=record["mentions"],
            quote=record["quote"],
            timestamp_ms=record["ts"],
            is_self=record["is_self"],
        )


@dataclass(frozen=True)
class ReplyJob:
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
    openwebui_message_id: str | None
    next_attempt_at: datetime | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, record: asyncpg.Record) -> "ReplyJob":
        return cls(
            msg_id=record["msg_id"],
            thread_id=record["thread_id"],
            thread_type=record["thread_type"],
            status=record["status"],
            attempts=record["attempts"],
            question=record["question"],
            answer=record["answer"],
            error=record["error"],
            skip_reason=record["skip_reason"],
            openwebui_chat_id=record["openwebui_chat_id"],
            openwebui_message_id=record["openwebui_message_id"],
            next_attempt_at=record["next_attempt_at"],
            created_at=record["created_at"],
            updated_at=record["updated_at"],
        )


@dataclass(frozen=True)
class QuestionAnswer:
    question: str
    answer: str


@dataclass(frozen=True)
class OutboxPart:
    """Một tin sẽ được gateway gửi lên Zalo."""

    chunk_index: int
    text: str
    quote_msg_id: str | None = None
    mention_uid: str | None = None
    mention_length: int | None = None


@dataclass(frozen=True)
class AgentAnswer:
    text: str
    chat_id: str | None = None
    message_id: str | None = None


@dataclass(frozen=True)
class AgentInfo:
    model_id: str
    name: str
    tool_ids: list[str] = field(default_factory=list)
    knowledge_names: list[str] = field(default_factory=list)
    function_calling: str = "native"
