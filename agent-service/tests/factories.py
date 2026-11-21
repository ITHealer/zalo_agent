"""Hàm tạo dữ liệu mẫu dùng chung cho test."""

from app.models import StoredMessage

BOT_UID = "1000"


def make_message(
    msg_id: str = "m1",
    text: str = "@Bot giá tour?",
    sender_name: str | None = "Khách A",
    sender_uid: str = "2000",
    thread_type: str = "group",
    timestamp_ms: int = 1_732_150_000_000,
    mentions: list[dict] | None = None,
    quote: dict | None = None,
    is_self: bool = False,
) -> StoredMessage:
    if mentions is None:
        mentions = [{"uid": BOT_UID, "pos": 0, "len": 4, "type": 0}]
    return StoredMessage(
        msg_id=msg_id,
        thread_id="g1",
        thread_type=thread_type,
        sender_uid=sender_uid,
        sender_name=sender_name,
        text=text,
        mentions=mentions,
        quote=quote,
        timestamp_ms=timestamp_ms,
        is_self=is_self,
    )
