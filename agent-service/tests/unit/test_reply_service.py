from datetime import UTC, datetime, timedelta

from app.core.config import Settings
from app.core.contracts import OutboxKind, ReplyStatus, Streams
from app.core.errors import OpenWebUIError
from app.models import AgentAnswer, ReplyJob
from app.services.reply_service import ReplyService, build_outbox_parts
from tests.factories import BOT_UID, make_message

# ---------------------------------------------------------------------------
# build_outbox_parts
# ---------------------------------------------------------------------------


def test_first_part_quotes_question_and_mentions_sender_in_group():
    question = make_message(msg_id="m1", sender_name="Khách A", sender_uid="2000")
    parts = build_outbox_parts("Giá 3.990.000đ", question, chunk_size=1800, mention_sender=True)

    assert len(parts) == 1
    assert parts[0].text == "@Khách A Giá 3.990.000đ"
    assert parts[0].quote_msg_id == "m1"
    assert parts[0].mention_uid == "2000"
    assert parts[0].mention_length == len("@Khách A")


def test_long_answer_is_split_and_only_first_part_quotes():
    question = make_message()
    answer = "a" * 50 + "\n" + "b" * 50
    parts = build_outbox_parts(answer, question, chunk_size=60, mention_sender=False)

    assert [part.chunk_index for part in parts] == [0, 1]
    assert parts[0].quote_msg_id == question.msg_id
    assert parts[1].quote_msg_id is None
    assert parts[0].mention_uid is None


def test_direct_message_reply_does_not_mention():
    question = make_message(thread_type="user")
    parts = build_outbox_parts("ok", question, chunk_size=1800, mention_sender=True)
    assert parts[0].text == "ok"
    assert parts[0].mention_uid is None


# ---------------------------------------------------------------------------
# ReplyService với các phụ thuộc giả lập trong bộ nhớ
# ---------------------------------------------------------------------------


def make_job(attempts: int = 1, answer: str | None = None) -> ReplyJob:
    now = datetime.now(UTC)
    return ReplyJob(
        msg_id="m1",
        thread_id="g1",
        thread_type="group",
        status=ReplyStatus.PROCESSING,
        attempts=attempts,
        question=None,
        answer=answer,
        error=None,
        skip_reason=None,
        openwebui_chat_id=None,
        openwebui_message_id=None,
        next_attempt_at=None,
        created_at=now,
        updated_at=now,
    )


class FakeReplyJobRepository:
    def __init__(self, job: ReplyJob | None):
        self.job = job
        self.events: list[tuple] = []

    async def claim(self, msg_id, lock_duration):
        return self.job

    async def save_answer(self, msg_id, question, answer, chat_id, message_id):
        self.events.append(("save_answer", question, answer))

    async def mark_sending(self, msg_id):
        self.events.append(("mark_sending",))

    async def mark_skipped(self, msg_id, reason):
        self.events.append(("mark_skipped", reason))

    async def mark_failed(self, msg_id, error_message):
        self.events.append(("mark_failed", error_message))

    async def schedule_retry(self, msg_id, delay, error_message):
        self.events.append(("schedule_retry", delay))

    async def find_recent_answered(self, thread_id, exclude_msg_id, limit):
        return []


class FakeMessageRepository:
    async def find_by_id(self, msg_id):
        return make_message(msg_id=msg_id)

    async def find_recent_in_thread(self, thread_id, until_timestamp_ms, limit):
        return []


class FakeThreadRepository:
    async def find_name(self, thread_id):
        return "Nhóm A"


class FakeOutboxRepository:
    def __init__(self):
        self.added: list[tuple] = []

    async def add_parts(self, reply_msg_id, thread_id, thread_type, parts, kind=OutboxKind.ANSWER):
        self.added.append((kind, parts))


class FakeOpenWebUIClient:
    def __init__(self, answer_text: str = "**Giá** 3.990.000đ", error: Exception | None = None):
        self.answer_text = answer_text
        self.error = error
        self.call_count = 0

    async def ask(self, thread_id, thread_title, messages):
        self.call_count += 1
        if self.error:
            raise self.error
        return AgentAnswer(text=self.answer_text, chat_id="chat-1", message_id="msg-1")


class FakePublisher:
    def __init__(self):
        self.published: list[tuple] = []

    async def publish(self, stream_name, payload):
        self.published.append((stream_name, payload))


class FakeGatewayStatusReader:
    async def get_bot_uid(self):
        return BOT_UID


class FakeAlertNotifier:
    def __init__(self):
        self.alerts: list[str] = []

    async def send(self, title, detail=""):
        self.alerts.append(title)


def build_service(job, openwebui_client, **setting_overrides):
    settings = Settings(openwebui_api_key="x", openwebui_model="m", reply_max_attempts=3, **setting_overrides)
    repositories = {
        "reply_jobs": FakeReplyJobRepository(job),
        "outbox": FakeOutboxRepository(),
        "publisher": FakePublisher(),
        "alerts": FakeAlertNotifier(),
    }
    service = ReplyService(
        settings=settings,
        reply_job_repository=repositories["reply_jobs"],
        message_repository=FakeMessageRepository(),
        thread_repository=FakeThreadRepository(),
        outbox_repository=repositories["outbox"],
        openwebui_client=openwebui_client,
        stream_publisher=repositories["publisher"],
        gateway_status_reader=FakeGatewayStatusReader(),
        alert_notifier=repositories["alerts"],
    )
    return service, repositories


async def test_successful_reply_is_saved_written_to_outbox_and_published():
    service, fakes = build_service(make_job(), FakeOpenWebUIClient())
    await service.process("m1")

    assert ("save_answer", "giá tour?", "Giá 3.990.000đ") in fakes["reply_jobs"].events
    assert ("mark_sending",) in fakes["reply_jobs"].events
    kind, parts = fakes["outbox"].added[0]
    assert kind == OutboxKind.ANSWER
    assert parts[0].text == "@Khách A Giá 3.990.000đ"
    assert fakes["publisher"].published == [(Streams.OUTBOX, {"reply_msg_id": "m1"})]


async def test_job_not_claimable_does_nothing():
    openwebui_client = FakeOpenWebUIClient()
    service, fakes = build_service(None, openwebui_client)
    await service.process("m1")
    assert openwebui_client.call_count == 0
    assert fakes["publisher"].published == []


async def test_existing_answer_is_reused_without_calling_agent_again():
    openwebui_client = FakeOpenWebUIClient()
    service, fakes = build_service(make_job(answer="Đã có câu trả lời"), openwebui_client)
    await service.process("m1")
    assert openwebui_client.call_count == 0
    assert fakes["outbox"].added[0][1][0].text.endswith("Đã có câu trả lời")


async def test_retryable_error_schedules_retry_with_backoff():
    error = OpenWebUIError("timeout", is_retryable=True)
    service, fakes = build_service(make_job(attempts=2), FakeOpenWebUIClient(error=error))
    await service.process("m1")
    assert fakes["reply_jobs"].events == [("schedule_retry", timedelta(seconds=20))]


async def test_last_attempt_marks_failed_alerts_and_sends_fallback():
    error = OpenWebUIError("timeout", is_retryable=True)
    service, fakes = build_service(
        make_job(attempts=3), FakeOpenWebUIClient(error=error), reply_fallback_text="Em sẽ phản hồi sau ạ"
    )
    await service.process("m1")

    assert fakes["reply_jobs"].events[0][0] == "mark_failed"
    assert fakes["alerts"].alerts == ["Bot không trả lời được 1 tin nhắn"]
    kind, parts = fakes["outbox"].added[0]
    assert kind == OutboxKind.FALLBACK
    assert parts[0].text == "Em sẽ phản hồi sau ạ"


async def test_permanent_error_fails_immediately():
    error = OpenWebUIError("401 unauthorized", is_retryable=False)
    service, fakes = build_service(make_job(attempts=1), FakeOpenWebUIClient(error=error))
    await service.process("m1")
    assert fakes["reply_jobs"].events[0][0] == "mark_failed"


async def test_empty_answer_is_skipped():
    service, fakes = build_service(make_job(), FakeOpenWebUIClient(answer_text="   "))
    await service.process("m1")
    assert ("mark_skipped", "empty_answer") in fakes["reply_jobs"].events
    assert fakes["outbox"].added == []
