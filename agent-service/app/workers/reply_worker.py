"""Nhận yêu cầu trả lời từ Redis Stream và giao cho ReplyService.

Các tin trong cùng một nhóm được xử lý lần lượt để câu trả lời không chen lẫn nhau.
"""

import asyncio
import logging
from collections import defaultdict

from app.repositories.reply_job_repository import ReplyJobRepository
from app.services.reply_service import ReplyService

logger = logging.getLogger(__name__)


class ReplyWorker:
    def __init__(self, reply_service: ReplyService, reply_job_repository: ReplyJobRepository):
        self._reply_service = reply_service
        self._reply_jobs = reply_job_repository
        self._thread_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def handle_reply_request(self, payload: dict[str, str]) -> None:
        """Handler cho stream zalo:reply-requests, payload {"msg_id": ...}."""
        msg_id = payload.get("msg_id")
        if not msg_id:
            logger.warning("Bỏ qua yêu cầu trả lời không có msg_id: %s", payload)
            return

        thread_id = await self._reply_jobs.find_thread_id(msg_id)
        if thread_id is None:
            logger.warning("Không tìm thấy reply job %s", msg_id)
            return

        async with self._thread_locks[thread_id]:
            await self._reply_service.process(msg_id)
