import asyncpg

from app.models import StoredMessage


class MessageRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def find_by_id(self, msg_id: str) -> StoredMessage | None:
        record = await self._pool.fetchrow("SELECT * FROM zalo_messages WHERE msg_id = $1", msg_id)
        if record is None:
            return None
        return StoredMessage.from_record(record)

    async def find_recent_in_thread(self, thread_id: str, until_timestamp_ms: int, limit: int) -> list[StoredMessage]:
        """N tin gần nhất trong nhóm tính đến thời điểm cho trước, xếp theo thời gian tăng dần."""
        records = await self._pool.fetch(
            """
            SELECT * FROM zalo_messages
            WHERE thread_id = $1 AND ts <= $2
            ORDER BY ts DESC
            LIMIT $3
            """,
            thread_id,
            until_timestamp_ms,
            limit,
        )
        messages = [StoredMessage.from_record(record) for record in records]
        messages.reverse()
        return messages

    async def list_by_thread(self, thread_id: str, limit: int) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            SELECT msg_id, sender_uid, sender_name, text, ts, is_self, triggers_bot, trigger_kind, source, received_at
            FROM zalo_messages
            WHERE thread_id = $1
            ORDER BY ts DESC
            LIMIT $2
            """,
            thread_id,
            limit,
        )
