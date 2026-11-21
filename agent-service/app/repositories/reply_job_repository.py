from datetime import timedelta

import asyncpg

from app.core.contracts import ReplyStatus
from app.models import QuestionAnswer, ReplyJob


class ReplyJobRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def find_by_id(self, msg_id: str) -> ReplyJob | None:
        record = await self._pool.fetchrow("SELECT * FROM reply_jobs WHERE msg_id = $1", msg_id)
        if record is None:
            return None
        return ReplyJob.from_record(record)

    async def find_thread_id(self, msg_id: str) -> str | None:
        return await self._pool.fetchval("SELECT thread_id FROM reply_jobs WHERE msg_id = $1", msg_id)

    async def claim(self, msg_id: str, lock_duration: timedelta) -> ReplyJob | None:
        """Giành quyền xử lý job (nguyên tử). Trả về None nếu job không ở trạng thái xử lý được
        hoặc đang được worker khác xử lý. Nhờ vậy nhận trùng message từ stream cũng không trả lời 2 lần."""
        record = await self._pool.fetchrow(
            """
            UPDATE reply_jobs
            SET status = $2,
                attempts = attempts + 1,
                locked_until = now() + $3::interval,
                updated_at = now()
            WHERE msg_id = $1
              AND (
                    (status IN ($4, $5) AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
                 OR (status = $2 AND locked_until < now())
              )
            RETURNING *
            """,
            msg_id,
            ReplyStatus.PROCESSING,
            lock_duration,
            ReplyStatus.QUEUED,
            ReplyStatus.ANSWERED,
        )
        if record is None:
            return None
        return ReplyJob.from_record(record)

    async def save_answer(
        self, msg_id: str, question: str, answer: str, chat_id: str | None, message_id: str | None
    ) -> None:
        await self._pool.execute(
            """
            UPDATE reply_jobs
            SET status = $2, question = $3, answer = $4, openwebui_chat_id = $5, openwebui_message_id = $6,
                error = NULL, updated_at = now()
            WHERE msg_id = $1
            """,
            msg_id,
            ReplyStatus.ANSWERED,
            question,
            answer,
            chat_id,
            message_id,
        )

    async def mark_sending(self, msg_id: str) -> None:
        await self._set_status(msg_id, ReplyStatus.SENDING)

    async def mark_skipped(self, msg_id: str, reason: str) -> None:
        await self._pool.execute(
            "UPDATE reply_jobs SET status = $2, skip_reason = $3, locked_until = NULL, updated_at = now() WHERE msg_id = $1",
            msg_id,
            ReplyStatus.SKIPPED,
            reason,
        )

    async def mark_failed(self, msg_id: str, error_message: str) -> None:
        await self._pool.execute(
            "UPDATE reply_jobs SET status = $2, error = $3, locked_until = NULL, updated_at = now() WHERE msg_id = $1",
            msg_id,
            ReplyStatus.FAILED,
            error_message,
        )

    async def schedule_retry(self, msg_id: str, delay: timedelta, error_message: str) -> None:
        """Trả job về hàng đợi, thử lại sau `delay`. Giữ nguyên câu trả lời nếu đã có (không gọi lại agent)."""
        await self._pool.execute(
            """
            UPDATE reply_jobs
            SET status = CASE WHEN answer IS NULL THEN $2 ELSE $3 END,
                next_attempt_at = now() + $4::interval,
                locked_until = NULL,
                error = $5,
                updated_at = now()
            WHERE msg_id = $1
            """,
            msg_id,
            ReplyStatus.QUEUED,
            ReplyStatus.ANSWERED,
            delay,
            error_message,
        )

    async def reset_for_manual_retry(self, msg_id: str) -> bool:
        result = await self._pool.execute(
            """
            UPDATE reply_jobs
            SET status = $2, attempts = 0, next_attempt_at = NULL, locked_until = NULL, error = NULL,
                answer = NULL, updated_at = now()
            WHERE msg_id = $1 AND status IN ($3, $4)
            """,
            msg_id,
            ReplyStatus.QUEUED,
            ReplyStatus.FAILED,
            ReplyStatus.SKIPPED,
        )
        return result.endswith(" 1")

    async def find_ids_ready_to_process(self, limit: int = 200) -> list[str]:
        """Job cần (xử lý lại): đến hạn thử lại, bị bỏ lửng giữa chừng, hoặc chưa ai nhận."""
        records = await self._pool.fetch(
            """
            SELECT msg_id FROM reply_jobs
            WHERE (status IN ($1, $2) AND COALESCE(next_attempt_at, updated_at + interval '20 seconds') <= now())
               OR (status = $3 AND locked_until < now())
            ORDER BY created_at
            LIMIT $4
            """,
            ReplyStatus.QUEUED,
            ReplyStatus.ANSWERED,
            ReplyStatus.PROCESSING,
            limit,
        )
        return [record["msg_id"] for record in records]

    async def find_recent_answered(self, thread_id: str, exclude_msg_id: str, limit: int) -> list[QuestionAnswer]:
        """Các lượt hỏi-đáp gần nhất của bot trong nhóm (để agent hiểu mạch hội thoại)."""
        records = await self._pool.fetch(
            """
            SELECT j.question, j.answer
            FROM reply_jobs j
            JOIN zalo_messages m ON m.msg_id = j.msg_id
            WHERE j.thread_id = $1 AND j.msg_id <> $2 AND j.status = $3
              AND j.question IS NOT NULL AND j.answer IS NOT NULL
            ORDER BY m.ts DESC
            LIMIT $4
            """,
            thread_id,
            exclude_msg_id,
            ReplyStatus.SENT,
            limit,
        )
        pairs = [QuestionAnswer(question=record["question"], answer=record["answer"]) for record in records]
        pairs.reverse()
        return pairs

    async def list_jobs(self, status: str | None, limit: int) -> list[ReplyJob]:
        if status:
            records = await self._pool.fetch(
                "SELECT * FROM reply_jobs WHERE status = $1 ORDER BY created_at DESC LIMIT $2", status, limit
            )
        else:
            records = await self._pool.fetch("SELECT * FROM reply_jobs ORDER BY created_at DESC LIMIT $1", limit)
        return [ReplyJob.from_record(record) for record in records]

    async def count_by_status(self) -> dict[str, int]:
        records = await self._pool.fetch("SELECT status, count(*)::int AS total FROM reply_jobs GROUP BY status")
        return {record["status"]: record["total"] for record in records}

    async def _set_status(self, msg_id: str, status: ReplyStatus) -> None:
        await self._pool.execute(
            "UPDATE reply_jobs SET status = $2, locked_until = NULL, updated_at = now() WHERE msg_id = $1",
            msg_id,
            status,
        )
