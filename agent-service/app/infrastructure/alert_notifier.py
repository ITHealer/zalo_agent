import logging
import time

import httpx

logger = logging.getLogger(__name__)

ALERT_COOLDOWN_SECONDS = 10 * 60


class AlertNotifier:
    """Gửi cảnh báo tới webhook (Slack / Google Chat / Teams nhận JSON {"text": ...}).

    Cùng một tiêu đề chỉ gửi lại sau 10 phút để tránh spam.
    """

    def __init__(self, webhook_url: str, http_client: httpx.AsyncClient):
        self._webhook_url = webhook_url
        self._http_client = http_client
        self._last_sent_at_by_title: dict[str, float] = {}

    async def send(self, title: str, detail: str = "") -> None:
        logger.warning("ALERT: %s %s", title, detail)
        if not self._webhook_url:
            return

        now = time.monotonic()
        last_sent_at = self._last_sent_at_by_title.get(title, 0.0)
        if last_sent_at and now - last_sent_at < ALERT_COOLDOWN_SECONDS:
            return
        self._last_sent_at_by_title[title] = now

        text = f"[agent-service] {title}"
        if detail:
            text = f"{text}\n{detail}"
        try:
            await self._http_client.post(self._webhook_url, json={"text": text}, timeout=10)
        except httpx.HTTPError as error:
            logger.warning("Gửi cảnh báo thất bại: %s", error)
