"""Composition root: khởi tạo và nối mọi thành phần của agent-service ở một chỗ duy nhất."""

import os
import socket
from dataclasses import dataclass

import asyncpg
import httpx
from redis.asyncio import Redis

from app.core.config import Settings
from app.core.contracts import ConsumerGroups, Streams
from app.infrastructure.alert_notifier import AlertNotifier
from app.infrastructure.database import create_database_pool
from app.infrastructure.gateway_status import GatewayStatusReader
from app.infrastructure.redis_streams import StreamConsumer, StreamPublisher
from app.repositories.message_repository import MessageRepository
from app.repositories.openwebui_chat_repository import OpenWebUIChatRepository
from app.repositories.outbox_repository import OutboxRepository
from app.repositories.reply_job_repository import ReplyJobRepository
from app.repositories.thread_repository import ThreadRepository
from app.services.openwebui_client import OpenWebUIClient
from app.services.reply_service import ReplyService
from app.workers.job_reconciler import JobReconciler
from app.workers.reply_worker import ReplyWorker


@dataclass
class Container:
    settings: Settings
    database_pool: asyncpg.Pool
    redis_client: Redis
    http_client: httpx.AsyncClient

    message_repository: MessageRepository
    thread_repository: ThreadRepository
    reply_job_repository: ReplyJobRepository
    outbox_repository: OutboxRepository

    stream_publisher: StreamPublisher
    gateway_status_reader: GatewayStatusReader
    openwebui_client: OpenWebUIClient
    reply_service: ReplyService
    reply_worker: ReplyWorker
    reply_request_consumer: StreamConsumer
    job_reconciler: JobReconciler

    async def close(self) -> None:
        await self.http_client.aclose()
        await self.redis_client.aclose()
        await self.database_pool.close()


async def build_container(settings: Settings) -> Container:
    database_pool = await create_database_pool(settings.database_url)
    redis_client = Redis.from_url(settings.redis_url, decode_responses=True)
    http_client = httpx.AsyncClient()

    message_repository = MessageRepository(database_pool)
    thread_repository = ThreadRepository(database_pool)
    reply_job_repository = ReplyJobRepository(database_pool)
    outbox_repository = OutboxRepository(database_pool)
    openwebui_chat_repository = OpenWebUIChatRepository(database_pool)

    stream_publisher = StreamPublisher(redis_client)
    gateway_status_reader = GatewayStatusReader(redis_client)
    alert_notifier = AlertNotifier(settings.alert_webhook_url, http_client)
    openwebui_client = OpenWebUIClient(settings, openwebui_chat_repository, http_client)

    reply_service = ReplyService(
        settings=settings,
        reply_job_repository=reply_job_repository,
        message_repository=message_repository,
        thread_repository=thread_repository,
        outbox_repository=outbox_repository,
        openwebui_client=openwebui_client,
        stream_publisher=stream_publisher,
        gateway_status_reader=gateway_status_reader,
        alert_notifier=alert_notifier,
    )
    reply_worker = ReplyWorker(reply_service, reply_job_repository)
    reply_request_consumer = StreamConsumer(
        redis_client=redis_client,
        stream_name=Streams.REPLY_REQUESTS,
        group_name=ConsumerGroups.AGENT_SERVICE,
        consumer_name=f"{socket.gethostname()}-{os.getpid()}",
        handle_message=reply_worker.handle_reply_request,
        max_concurrency=settings.worker_concurrency,
    )
    job_reconciler = JobReconciler(reply_job_repository, stream_publisher, settings.reconcile_interval_seconds)

    return Container(
        settings=settings,
        database_pool=database_pool,
        redis_client=redis_client,
        http_client=http_client,
        message_repository=message_repository,
        thread_repository=thread_repository,
        reply_job_repository=reply_job_repository,
        outbox_repository=outbox_repository,
        stream_publisher=stream_publisher,
        gateway_status_reader=gateway_status_reader,
        openwebui_client=openwebui_client,
        reply_service=reply_service,
        reply_worker=reply_worker,
        reply_request_consumer=reply_request_consumer,
        job_reconciler=job_reconciler,
    )
