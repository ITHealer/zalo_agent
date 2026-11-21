"""Dựng danh sách messages gửi cho agent trên OpenWebUI."""

import re
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from app.models import QuestionAnswer, StoredMessage
from app.services.text_formatter import remove_utf16_ranges

VIETNAM_TIMEZONE = ZoneInfo("Asia/Ho_Chi_Minh")
MAX_CONTEXT_LINE_LENGTH = 500
EMPTY_QUESTION_HINT = "(người dùng chỉ tag bot, không kèm nội dung - hãy chào và hỏi họ cần hỗ trợ gì)"


@dataclass(frozen=True)
class AgentPrompt:
    messages: list[dict[str, str]]
    question: str


def extract_question(message: StoredMessage, bot_uid: str | None) -> str:
    """Câu hỏi = nội dung tin, bỏ đoạn "@Tên bot"."""
    text = message.text or ""
    bot_mention_ranges = []
    for mention in message.mentions or []:
        is_bot_mention = bot_uid is not None and str(mention.get("uid")) == str(bot_uid)
        if is_bot_mention and mention.get("len", 0) > 0:
            bot_mention_ranges.append((int(mention["pos"]), int(mention["len"])))

    question = remove_utf16_ranges(text, bot_mention_ranges)
    return re.sub(r"\s+", " ", question).strip()


def format_context_line(message: StoredMessage) -> str:
    sent_at = datetime.fromtimestamp(message.timestamp_ms / 1000, tz=VIETNAM_TIMEZONE)
    sender = "Bot" if message.is_self else (message.sender_name or message.sender_uid)
    text = (message.text or "")[:MAX_CONTEXT_LINE_LENGTH]
    return f"[{sent_at:%d/%m %H:%M}] {sender}: {text}"


def build_agent_prompt(
    question_message: StoredMessage,
    recent_messages: list[StoredMessage],
    previous_answers: list[QuestionAnswer],
    group_name: str | None,
    bot_uid: str | None,
) -> AgentPrompt:
    """
    - Không gửi system prompt: giữ nguyên cấu hình của agent trên OpenWebUI.
    - Các lượt hỏi-đáp trước của bot -> cặp user/assistant.
    - Tin cuối (user) = ngữ cảnh nhóm gần đây + câu hỏi hiện tại.
    """
    question = extract_question(question_message, bot_uid)

    context_lines = [
        format_context_line(message) for message in recent_messages if message.msg_id != question_message.msg_id
    ]

    sections = []
    if group_name:
        sections.append(f'Bạn đang được hỏi trong nhóm Zalo "{group_name}".')
    else:
        sections.append("Bạn đang được hỏi trong một nhóm Zalo.")

    if context_lines:
        sections.append(
            "Các tin nhắn gần đây trong nhóm (để hiểu ngữ cảnh, không cần trả lời từng tin):\n"
            + "\n".join(context_lines)
        )

    quoted_text = (question_message.quote or {}).get("msg")
    if quoted_text:
        sections.append(f'Tin nhắn đang được trả lời (quote): "{str(quoted_text)[:MAX_CONTEXT_LINE_LENGTH]}"')

    sections.append(f"Người hỏi: {question_message.sender_name or 'Thành viên'}")
    sections.append(f"Câu hỏi: {question or EMPTY_QUESTION_HINT}")
    sections.append("Trả lời ngắn gọn, tự nhiên, bằng văn bản thuần (Zalo không hiển thị Markdown).")

    messages: list[dict[str, str]] = []
    for previous in previous_answers:
        messages.append({"role": "user", "content": previous.question})
        messages.append({"role": "assistant", "content": previous.answer})
    messages.append({"role": "user", "content": "\n\n".join(sections)})

    return AgentPrompt(messages=messages, question=question)
