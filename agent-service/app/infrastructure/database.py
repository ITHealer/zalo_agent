import json
import logging
from pathlib import Path

import asyncpg

logger = logging.getLogger(__name__)

MIGRATIONS_DIRECTORY = Path(__file__).resolve().parents[2] / "migrations"
MIGRATION_LOCK_ID = 424242


async def _configure_connection(connection: asyncpg.Connection) -> None:
    # Cột JSONB trả về dict/list Python thay vì chuỗi
    await connection.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def create_database_pool(database_url: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(database_url, min_size=1, max_size=10, init=_configure_connection)


async def run_migrations(pool: asyncpg.Pool) -> None:
    """Chạy các file migrations/*.sql chưa chạy, theo thứ tự tên file. An toàn khi nhiều process cùng chạy."""
    async with pool.acquire() as connection:
        await connection.execute("SELECT pg_advisory_lock($1)", MIGRATION_LOCK_ID)
        try:
            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    name TEXT PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
            for migration_file in sorted(MIGRATIONS_DIRECTORY.glob("*.sql")):
                already_applied = await connection.fetchval(
                    "SELECT 1 FROM schema_migrations WHERE name = $1", migration_file.name
                )
                if already_applied:
                    continue
                async with connection.transaction():
                    await connection.execute(migration_file.read_text(encoding="utf-8"))
                    await connection.execute("INSERT INTO schema_migrations (name) VALUES ($1)", migration_file.name)
                logger.info("Đã chạy migration %s", migration_file.name)
        finally:
            await connection.execute("SELECT pg_advisory_unlock($1)", MIGRATION_LOCK_ID)
