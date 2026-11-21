import asyncpg

from app.core.contracts import OutboxKind
from app.models import OutboxPart


class OutboxRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def add_parts(
        self,
        reply_msg_id: str,
        thread_id: str,
        thread_type: str,
        parts: list[OutboxPart],
        kind: OutboxKind = OutboxKind.ANSWER,
    ) -> None:
        """Ghi các phần cần gửi. Chạy lại nhiều lần cũng không tạo trùng (UNIQUE reply_msg_id, kind, chunk_index)."""
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                for part in parts:
                    await connection.execute(
                        """
                        INSERT INTO outbox_messages
                            (reply_msg_id, kind, chunk_index, thread_id, thread_type, text,
                             quote_msg_id, mention_uid, mention_length)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        ON CONFLICT (reply_msg_id, kind, chunk_index) DO NOTHING
                        """,
                        reply_msg_id,
                        kind,
                        part.chunk_index,
                        thread_id,
                        thread_type,
                        part.text,
                        part.quote_msg_id,
                        part.mention_uid,
                        part.mention_length,
                    )

    async def list_by_reply(self, reply_msg_id: str) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            SELECT id, kind, chunk_index, text, status, attempts, zalo_msg_id, error, sent_at
            FROM outbox_messages WHERE reply_msg_id = $1 ORDER BY kind, chunk_index
            """,
            reply_msg_id,
        )

    async def delete_unsent(self, reply_msg_id: str) -> None:
        """Xoá các phần chưa gửi được (dùng khi thử lại thủ công một câu trả lời)."""
        await self._pool.execute(
            "DELETE FROM outbox_messages WHERE reply_msg_id = $1 AND status <> 'sent'", reply_msg_id
        )
