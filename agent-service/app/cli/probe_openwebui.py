"""Kiểm tra kết nối tới agent trên OpenWebUI trước khi chạy bot.

    python -m app.cli.probe_openwebui "Câu hỏi thử"

In ra phiên bản OpenWebUI, cấu hình agent (tool, knowledge) và gửi 1 câu hỏi thử
theo đúng cách bot sẽ gọi.
"""

import asyncio
import sys
import time

import httpx

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.infrastructure.database import create_database_pool, run_migrations
from app.repositories.openwebui_chat_repository import OpenWebUIChatRepository
from app.services.openwebui_client import OpenWebUIClient

DEFAULT_QUESTION = "Xin chào, bạn có thể giúp gì cho tôi?"


async def main(question: str) -> int:
    settings = get_settings()
    configure_logging("WARNING")

    missing_settings = settings.missing_required_settings()
    if missing_settings:
        print(f"Thiếu biến môi trường: {', '.join(missing_settings)}")
        return 1

    pool = await create_database_pool(settings.database_url)
    async with httpx.AsyncClient() as http_client:
        try:
            await run_migrations(pool)
            client = OpenWebUIClient(settings, OpenWebUIChatRepository(pool), http_client)

            version = await client.get_version()
            print(f"OpenWebUI: {settings.openwebui_url} - phiên bản {version.get('version')}")

            agent = await client.get_agent_info(force_refresh=True)
            print(f"Agent: {agent.name} ({agent.model_id})")
            print(f"  Tool đang gắn: {agent.tool_ids or 'không có'}")
            print(f"  Knowledge: {agent.knowledge_names or 'không có'}")
            print(f"  Function calling: {agent.function_calling}")
            print(f"Chế độ gọi: {settings.openwebui_mode} | builtin tools (KB): {settings.openwebui_enable_builtin_tools}")

            started_at = time.monotonic()
            answer = await client.ask("probe", "Probe kết nối", [{"role": "user", "content": question}])
            print(f"\nTrả lời sau {time.monotonic() - started_at:.1f}s:\n{answer.text}\n")
            if answer.chat_id:
                print(f"Xem chi tiết tool đã gọi: {settings.openwebui_url.rstrip('/')}/c/{answer.chat_id}")
            return 0
        except Exception as error:
            print(f"LỖI: {error}")
            return 1
        finally:
            await pool.close()


if __name__ == "__main__":
    question_argument = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_QUESTION
    sys.exit(asyncio.run(main(question_argument)))
