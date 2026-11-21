from app.services.text_formatter import (
    markdown_to_plain_text,
    remove_utf16_ranges,
    split_into_chunks,
    utf16_length,
)


def test_markdown_is_converted_to_plain_text():
    markdown = "## Giá\n**3.990.000đ**\n- Ăn sáng\n[Link](https://a.b)"
    assert markdown_to_plain_text(markdown) == "Giá\n3.990.000đ\n• Ăn sáng\nLink (https://a.b)"


def test_openwebui_details_block_is_removed():
    text = '<details type="tool_calls">gọi tool</details>\nCâu trả lời'
    assert markdown_to_plain_text(text) == "Câu trả lời"


def test_long_text_is_split_at_line_break():
    text = "a" * 50 + "\n" + "b" * 50
    chunks = split_into_chunks(text, 60)
    assert chunks == ["a" * 50, "b" * 50]


def test_short_text_is_single_chunk():
    assert split_into_chunks("xin chào", 100) == ["xin chào"]


def test_utf16_length_counts_emoji_as_two_units():
    assert utf16_length("@An") == 3
    assert utf16_length("@An😀") == 5


def test_remove_utf16_ranges_handles_emoji_before_mention():
    # "😀" chiếm 2 đơn vị UTF-16 nên "@Bot" bắt đầu ở vị trí 3 theo cách tính của Zalo
    text = "😀 @Bot giá tour?"
    assert remove_utf16_ranges(text, [(3, 4)]) == "😀  giá tour?"
