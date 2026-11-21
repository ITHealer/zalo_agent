from app.models import QuestionAnswer
from app.services.prompt_builder import build_agent_prompt, extract_question
from tests.factories import BOT_UID, make_message


def test_bot_mention_is_removed_from_question():
    message = make_message(
        text="@UrBox Bot cho hỏi giá @An nhé",
        mentions=[
            {"uid": BOT_UID, "pos": 0, "len": 10, "type": 0},
            {"uid": "2000", "pos": 23, "len": 3, "type": 0},
        ],
    )
    assert extract_question(message, BOT_UID) == "cho hỏi giá @An nhé"


def test_question_is_kept_when_bot_uid_unknown():
    message = make_message(text="@Bot giá tour?")
    assert extract_question(message, None) == "@Bot giá tour?"


def test_prompt_contains_context_and_previous_answers():
    question_message = make_message(msg_id="m3", text="@Bot giá?", sender_name="An")
    recent_messages = [
        make_message(msg_id="m1", text="tour Đà Lạt tháng 12", sender_name="Bình", mentions=[]),
        question_message,
    ]
    previous_answers = [QuestionAnswer(question="q1", answer="a1")]

    prompt = build_agent_prompt(question_message, recent_messages, previous_answers, "Nhóm A", BOT_UID)

    assert prompt.question == "giá?"
    assert [message["role"] for message in prompt.messages] == ["user", "assistant", "user"]
    last_content = prompt.messages[-1]["content"]
    assert 'nhóm Zalo "Nhóm A"' in last_content
    assert "Bình: tour Đà Lạt tháng 12" in last_content
    assert "An: @Bot giá?" not in last_content  # tin đang hỏi không lặp lại trong phần ngữ cảnh
    assert "Câu hỏi: giá?" in last_content


def test_prompt_includes_quoted_message():
    question_message = make_message(text="@Bot còn chỗ không?", quote={"msg": "Tour Phú Quốc 3N2Đ", "ownerId": "3000"})
    prompt = build_agent_prompt(question_message, [], [], None, BOT_UID)
    assert 'Tin nhắn đang được trả lời (quote): "Tour Phú Quốc 3N2Đ"' in prompt.messages[-1]["content"]


def test_empty_question_gets_hint():
    question_message = make_message(text="@Bot")
    prompt = build_agent_prompt(question_message, [], [], None, BOT_UID)
    assert "chỉ tag bot" in prompt.messages[-1]["content"]
