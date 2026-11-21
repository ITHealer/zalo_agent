import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import health, reply_jobs, threads, zalo
from app.container import build_container
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.infrastructure.database import run_migrations

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)

    missing_settings = settings.missing_required_settings()
    if missing_settings:
        raise RuntimeError(f"Thiếu biến môi trường: {', '.join(missing_settings)}")

    container = await build_container(settings)
    await run_migrations(container.database_pool)
    app.state.container = container

    await container.reply_request_consumer.start()
    container.job_reconciler.start()
    logger.info("agent-service đã sẵn sàng (OpenWebUI mode=%s)", settings.openwebui_mode)

    yield

    logger.info("Đang dừng agent-service...")
    await container.job_reconciler.stop()
    await container.reply_request_consumer.stop()
    await container.close()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Zalo Agent Service",
        description="Trả lời tin nhắn nhóm Zalo bằng agent trên OpenWebUI",
        version="0.2.0",
        lifespan=lifespan,
    )
    app.include_router(health.router)
    app.include_router(zalo.router)
    app.include_router(reply_jobs.router)
    app.include_router(threads.router)
    return app


app = create_app()
