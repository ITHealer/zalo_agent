"""Chạy migration database.

    python -m app.cli.migrate
"""

import asyncio

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.infrastructure.database import create_database_pool, run_migrations


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    pool = await create_database_pool(settings.database_url)
    try:
        await run_migrations(pool)
        print("Migration OK")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
