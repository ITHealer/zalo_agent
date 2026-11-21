"""Redis Stream chỉ dùng để "báo có việc".

Trạng thái thật nằm trong Postgres, nên mỗi message luôn được ACK sau khi xử lý (kể cả khi lỗi):
việc thử lại do bộ đối soát (JobReconciler) đảm nhiệm dựa trên dữ liệu trong DB.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

from redis.asyncio import Redis
from redis.exceptions import ResponseError

logger = logging.getLogger(__name__)

STREAM_MAX_LENGTH = 100_000


class StreamPublisher:
    def __init__(self, redis_client: Redis):
        self._redis = redis_client

    async def publish(self, stream_name: str, payload: dict[str, str]) -> None:
        await self._redis.xadd(stream_name, payload, maxlen=STREAM_MAX_LENGTH, approximate=True)


MessageHandler = Callable[[dict[str, str]], Awaitable[None]]


class StreamConsumer:
    """Đọc stream theo consumer group. Mỗi message được xử lý trong 1 task riêng, giới hạn bởi max_concurrency."""

    def __init__(
        self,
        redis_client: Redis,
        stream_name: str,
        group_name: str,
        consumer_name: str,
        handle_message: MessageHandler,
        max_concurrency: int,
    ):
        self._redis = redis_client
        self._stream_name = stream_name
        self._group_name = group_name
        self._consumer_name = consumer_name
        self._handle_message = handle_message
        self._concurrency_limit = asyncio.Semaphore(max_concurrency)
        self._running_tasks: set[asyncio.Task] = set()
        self._is_running = False
        self._loop_task: asyncio.Task | None = None

    async def start(self) -> None:
        await self._ensure_group_exists()
        self._is_running = True
        self._loop_task = asyncio.create_task(self._read_loop(), name=f"consumer:{self._stream_name}")

    async def stop(self) -> None:
        self._is_running = False
        if self._loop_task:
            self._loop_task.cancel()
            await asyncio.gather(self._loop_task, return_exceptions=True)
        await asyncio.gather(*self._running_tasks, return_exceptions=True)

    async def _ensure_group_exists(self) -> None:
        try:
            await self._redis.xgroup_create(self._stream_name, self._group_name, id="0", mkstream=True)
        except ResponseError as error:
            if "BUSYGROUP" not in str(error):
                raise

    async def _read_loop(self) -> None:
        while self._is_running:
            try:
                response = await self._redis.xreadgroup(
                    groupname=self._group_name,
                    consumername=self._consumer_name,
                    streams={self._stream_name: ">"},
                    count=10,
                    block=2000,
                )
                for _stream, entries in response or []:
                    for entry_id, fields in entries:
                        await self._concurrency_limit.acquire()
                        task = asyncio.create_task(self._process_entry(entry_id, fields))
                        self._running_tasks.add(task)
                        task.add_done_callback(self._running_tasks.discard)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Lỗi đọc stream %s, thử lại sau 2s", self._stream_name)
                await asyncio.sleep(2)

    async def _process_entry(self, entry_id: str, fields: dict[str, str]) -> None:
        try:
            await self._handle_message(fields)
        except Exception:
            logger.exception("Xử lý message %s từ stream %s lỗi", entry_id, self._stream_name)
        finally:
            self._concurrency_limit.release()
            await self._redis.xack(self._stream_name, self._group_name, entry_id)
