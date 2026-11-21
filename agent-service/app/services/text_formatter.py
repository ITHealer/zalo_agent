"""Xử lý văn bản: Zalo không hiển thị Markdown và giới hạn độ dài mỗi tin."""

import re

_MARKDOWN_RULES: list[tuple[re.Pattern[str], str]] = [
    # Khối <details> OpenWebUI chèn khi hiển thị tool call / reasoning
    (re.compile(r"<details[\s\S]*?</details>"), ""),
    (re.compile(r"```[a-zA-Z]*\n?([\s\S]*?)```"), r"\1"),
    (re.compile(r"\*\*(.+?)\*\*"), r"\1"),
    (re.compile(r"__(.+?)__"), r"\1"),
    (re.compile(r"(^|\s)\*(\S.*?)\*(?=\s|$)"), r"\1\2"),
    (re.compile(r"`([^`]+)`"), r"\1"),
    (re.compile(r"^#{1,6}\s+", re.MULTILINE), ""),
    (re.compile(r"^\s*[-*]\s+", re.MULTILINE), "• "),
    (re.compile(r"\[([^\]]+)\]\((https?:[^)]+)\)"), r"\1 (\2)"),
    (re.compile(r"\n{3,}"), "\n\n"),
]


def markdown_to_plain_text(markdown_text: str) -> str:
    text = markdown_text or ""
    for pattern, replacement in _MARKDOWN_RULES:
        text = pattern.sub(replacement, text)
    return text.strip()


def split_into_chunks(text: str, max_length: int) -> list[str]:
    """Chia văn bản dài thành nhiều tin, ưu tiên cắt ở xuống dòng rồi tới dấu chấm câu."""
    chunks: list[str] = []
    remaining_text = text.strip()

    while len(remaining_text) > max_length:
        cut_position = remaining_text.rfind("\n", 0, max_length)
        if cut_position < max_length // 2:
            cut_position = remaining_text.rfind(". ", 0, max_length) + 1
        if cut_position < max_length // 2:
            cut_position = max_length

        chunks.append(remaining_text[:cut_position].strip())
        remaining_text = remaining_text[cut_position:].strip()

    if remaining_text:
        chunks.append(remaining_text)
    return chunks


def utf16_length(text: str) -> int:
    """Độ dài theo đơn vị UTF-16 - cách Zalo (JavaScript) tính vị trí/độ dài mention."""
    return len(text.encode("utf-16-le")) // 2


def remove_utf16_ranges(text: str, ranges: list[tuple[int, int]]) -> str:
    """Xoá các đoạn (vị trí, độ dài) tính theo UTF-16 khỏi văn bản.

    Không cắt trực tiếp bằng chỉ số Python vì emoji chiếm 2 đơn vị UTF-16 nhưng chỉ 1 ký tự Python.
    """
    encoded = text.encode("utf-16-le")
    for position, length in sorted(ranges, reverse=True):
        start_byte = position * 2
        end_byte = (position + length) * 2
        encoded = encoded[:start_byte] + encoded[end_byte:]
    return encoded.decode("utf-16-le", errors="ignore")
