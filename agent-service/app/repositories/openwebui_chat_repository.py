import asyncpg


class OpenWebUIChatRepository:
    """Ghi nhớ chat OpenWebUI tương ứng với mỗi nhóm Zalo."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def find_chat_id(self, chat_key: str) -> str | None:
        return await self._pool.fetchval("SELECT chat_id FROM openwebui_chats WHERE chat_key = $1", chat_key)

    async def save(self, chat_key: str, thread_id: str, chat_id: str) -> None:
        await self._pool.execute(
            """
            INSERT INTO openwebui_chats (chat_key, thread_id, chat_id) VALUES ($1, $2, $3)
            ON CONFLICT (chat_key) DO UPDATE SET chat_id = EXCLUDED.chat_id
            """,
            chat_key,
            thread_id,
            chat_id,
        )
