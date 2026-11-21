import json
from typing import Any

from redis.asyncio import Redis

from app.core.contracts import RedisKeys


class GatewayStatusReader:
    """Đọc trạng thái và mã QR mà zalo-gateway công bố lên Redis."""

    def __init__(self, redis_client: Redis):
        self._redis = redis_client

    async def get_status(self) -> dict[str, Any] | None:
        raw_status = await self._redis.get(RedisKeys.GATEWAY_STATUS)
        if raw_status is None:
            return None  # gateway không chạy hoặc đã treo quá 60s
        return json.loads(raw_status)

    async def get_qr_code(self) -> dict[str, Any] | None:
        raw_qr = await self._redis.get(RedisKeys.GATEWAY_QR)
        if raw_qr is None:
            return None
        return json.loads(raw_qr)

    async def get_bot_uid(self) -> str | None:
        status = await self.get_status()
        if status is None:
            return None
        return (status.get("zalo") or {}).get("botUid")
