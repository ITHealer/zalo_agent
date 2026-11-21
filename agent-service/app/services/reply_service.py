"""Xử lý 1 yêu cầu trả lời: hỏi agent -> lưu câu trả lời -> ghi outbox -> báo gateway gửi."""

import logging
from datetime import timedelta

from app.core.config import Settings
from app.core.contracts import OutboxKind, Streams
from app.core.errors import PermanentError
from app.infrastructure.alert_notifier import AlertNotifier
from app.infrastructure.gateway_status import GatewayStatusReader
from app.infrastructure.redis_streams import StreamPublisher
from app.models import OutboxPart, ReplyJob, StoredMessage
from app.repositories.message_repository import MessageRepository
from app.repositories.outbox_repository import OutboxRepository
from app.repositories.reply_job_repository import ReplyJobRepository
from app.repositories.thread_repository import ThreadRepository
from app.services.openwebui_client import OpenWebUIClient
from app.services.prompt_builder import build_agent_prompt
from app.services.text_formatter import markdown_to_plain_text, split_into_chunks, utf16_length

logger = logging.getLogger(__name__)


def build_outbox_parts(answer: str, question_message: StoredMessage, chunk_size: int, mention_sender: bool) -> list[OutboxPart]:
    """Chia câu trả lời thành các tin. Tin đầu quote câu hỏi và @ người hỏi (trong nhóm)."""
    chunks = split_into_chunks(answer, chunk_size)
    parts = []
    for chunk_index, chunk_text in enumerate(chunks):
        is_first_chunk = chunk_index == 0
        if not is_first_chunk:
            parts.append(OutboxPart(chunk_index=chunk_index, text=chunk_text))
            continue

        should_mention = mention_sender and question_message.thread_type == "group" and question_message.sender_name
        if should_mention:
            mention_tag = f"@{question_message.sender_name}"
            parts.append(
                OutboxPart(
                    chunk_index=chunk_index,
                    text=f"{mention_tag} {chunk_text}",
                    quote_msg_id=question_message.msg_id,
                    mention_uid=question_message.sender_uid,
                    mention_length=utf16_length(mention_tag),
                )
            )
        else:
            parts.append(OutboxPart(chunk_index=chunk_index, text=chunk_text, quote_msg_id=question_message.msg_id))
    return parts


class ReplyService:
    def __init__(
        self,
        settings: Settings,
        reply_job_repository: ReplyJobRepository,
        message_repository: MessageRepository,
        thread_repository: ThreadRepository,
        outbox_repository: OutboxRepository,
        openwebui_client: OpenWebUIClient,
        stream_publisher: StreamPublisher,
        gateway_status_reader: GatewayStatusReader,
        alert_notifier: AlertNotifier,
    ):
        self._settings = settings
        self._reply_jobs = reply_job_repository
        self._messages = message_repository
        self._threads = thread_repository
        self._outbox = outbox_repository
        self._openwebui = openwebui_client
        self._publisher = stream_publisher
        self._gateway_status = gateway_status_reader
        self._alerts = alert_notifier

    async def process(self, msg_id: str) -> None:
        lock_duration = timedelta(seconds=self._settings.processing_lock_seconds)
        job = await self._reply_jobs.claim(msg_id, lock_duration)
        if job is None:
            return  # đã xử lý xong, chưa đến hạn thử lại, hoặc worker khác đang xử lý

        try:
            await self._answer_and_enqueue(job)
        except Exception as error:
            await self._handle_failure(job, error)

    async def _answer_and_enqueue(self, job: ReplyJob) -> None:
        question_message = await self._messages.find_by_id(job.msg_id)
        if question_message is None:
            raise PermanentError(f"Không tìm thấy tin nhắn {job.msg_id}")

        answer = job.answer
        if answer is None:
            # Chưa có câu trả lời -> hỏi agent. (Đã có = lần trước lỗi ở bước sau, không gọi lại agent.)
            answer = await self._generate_answer(job, question_message)

        if not answer.strip():
            await self._reply_jobs.mark_skipped(job.msg_id, "empty_answer")
            logger.warning("Agent trả lời rỗng cho tin %s, bỏ qua", job.msg_id)
            return

        parts = build_outbox_parts(
            answer, question_message, self._settings.reply_chunk_size, self._settings.reply_mention_sender
        )
        await self._outbox.add_parts(job.msg_id, job.thread_id, job.thread_type, parts)
        await self._reply_jobs.mark_sending(job.msg_id)
        await self._publisher.publish(Streams.OUTBOX, {"reply_msg_id": job.msg_id})
        logger.info("Đã ghi câu trả lời (%d tin) cho %s vào outbox", len(parts), job.msg_id)

    async def _generate_answer(self, job: ReplyJob, question_message: StoredMessage) -> str:
        recent_messages = await self._messages.find_recent_in_thread(
            job.thread_id, question_message.timestamp_ms, self._settings.reply_context_messages
        )
        previous_answers = await self._reply_jobs.find_recent_answered(
            job.thread_id, job.msg_id, self._settings.openwebui_history_turns
        )
        group_name = await self._threads.find_name(job.thread_id)
        bot_uid = await self._gateway_status.get_bot_uid()

        prompt = build_agent_prompt(question_message, recent_messages, previous_answers, group_name, bot_uid)
        agent_answer = await self._openwebui.ask(job.thread_id, group_name, prompt.messages)
        answer = markdown_to_plain_text(agent_answer.text)

        await self._reply_jobs.save_answer(
            job.msg_id, prompt.question, answer, agent_answer.chat_id, agent_answer.message_id
        )
        return answer

    async def _handle_failure(self, job: ReplyJob, error: Exception) -> None:
        error_message = str(error)[:2000]
        is_retryable = getattr(error, "is_retryable", True)
        has_attempts_left = job.attempts < self._settings.reply_max_attempts

        if is_retryable and has_attempts_left:
            delay = timedelta(seconds=self._settings.reply_retry_base_delay_seconds * 2 ** (job.attempts - 1))
            await self._reply_jobs.schedule_retry(job.msg_id, delay, error_message)
            logger.warning(
                "Trả lời tin %s lỗi (lần %d), thử lại sau %ss: %s", job.msg_id, job.attempts, delay.seconds, error_message
            )
            return

        await self._reply_jobs.mark_failed(job.msg_id, error_message)
        logger.error("Trả lời tin %s thất bại hẳn sau %d lần: %s", job.msg_id, job.attempts, error_message)
        await self._alerts.send("Bot không trả lời được 1 tin nhắn", f"msg_id={job.msg_id}: {error_message}")
        await self._send_fallback_message(job)

    async def _send_fallback_message(self, job: ReplyJob) -> None:
        fallback_text = self._settings.reply_fallback_text
        if not fallback_text:
            return
        fallback_part = OutboxPart(chunk_index=0, text=fallback_text, quote_msg_id=job.msg_id)
        await self._outbox.add_parts(job.msg_id, job.thread_id, job.thread_type, [fallback_part], OutboxKind.FALLBACK)
        await self._publisher.publish(Streams.OUTBOX, {"reply_msg_id": job.msg_id})
