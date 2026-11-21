import asyncpg


class ThreadRepository:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def find_name(self, thread_id: str) -> str | None:
        return await self._pool.fetchval("SELECT name FROM zalo_threads WHERE thread_id = $1", thread_id)

    async def list_all(self) -> list[asyncpg.Record]:
        return await self._pool.fetch(
            """
            SELECT t.thread_id, t.thread_type, t.name, t.last_ts, t.last_swept_at,
                   (SELECT count(*) FROM zalo_messages m WHERE m.thread_id = t.thread_id) AS message_count
            FROM zalo_threads t
            ORDER BY t.last_ts DESC NULLS LAST
            """
        )
