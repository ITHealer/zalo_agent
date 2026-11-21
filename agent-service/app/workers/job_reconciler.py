"""Lưới an toàn: định kỳ tìm job cần xử lý (lại) trong DB và đưa vào stream.

Bao các trường hợp: đến hạn thử lại sau lỗi, worker chết giữa chừng (hết hạn khoá),
gateway ghi DB xong nhưng chưa kịp báo qua Redis, Redis bị mất dữ liệu.
"""

import asyncio
import logging

from app.core.contracts import Streams
from app.infrastructure.redis_streams import StreamPublisher
from app.repositories.reply_job_repository import ReplyJobRepository

logger = logging.getLogger(__name__)


class JobReconciler:
    def __init__(self, reply_job_repository: ReplyJobRepository, stream_publisher: StreamPublisher, interval_seconds: int):
        self._reply_jobs = reply_job_repository
        self._publisher = stream_publisher
        self._interval_seconds = interval_seconds
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run_forever(), name="job-reconciler")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def reconcile_once(self) -> int:
        msg_ids = await self._reply_jobs.find_ids_ready_to_process()
        for msg_id in msg_ids:
            await self._publisher.publish(Streams.REPLY_REQUESTS, {"msg_id": msg_id})
        if msg_ids:
            logger.info("Đối soát: đưa lại %d job vào hàng xử lý", len(msg_ids))
        return len(msg_ids)

    async def _run_forever(self) -> None:
        while True:
            try:
                await self.reconcile_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Đối soát job lỗi")
            await asyncio.sleep(self._interval_seconds)
