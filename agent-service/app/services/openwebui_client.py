"""Client gọi agent trên OpenWebUI.

Vì sao không gọi /api/chat/completions "trơn"? (đã kiểm chứng trên OpenWebUI 0.13.x)
  - Gửi {model, messages}: OpenWebUI BỎ QUA tool gắn trên agent.
  - Thêm tool_ids nhưng không có chat_id + message id: model trả tool_calls về cho client,
    OpenWebUI KHÔNG thực thi tool.
  - Có chat_id (chat đã lưu) + id (assistant message id) + stream=true: OpenWebUI chạy vòng lặp tool
    phía server giống hệt khi dùng trên giao diện, kết quả ghi vào chat -> đọc lại qua /api/v1/chats/{id}.
  - Có thêm session_id: bật builtin tools (gồm tra Knowledge Base gắn trên agent khi dùng function
    calling native). Khi đó API trả {task_ids} ngay và chạy nền -> poll chat tới khi message xong.

mode="chat" (mặc định) làm theo cách trên. mode="completions" là OpenAI-compatible đơn giản,
chỉ phù hợp agent KHÔNG cần tool.
"""

import asyncio
import logging
import time
import uuid
from datetime import date
from typing import Any

import httpx

from app.core.config import Settings
from app.core.errors import OpenWebUIError
from app.models import AgentAnswer, AgentInfo
from app.repositories.openwebui_chat_repository import OpenWebUIChatRepository

logger = logging.getLogger(__name__)

AGENT_INFO_CACHE_SECONDS = 300
NO_TOOLS_KEYWORD = "none"


def extract_message_text(message: dict[str, Any] | None) -> str:
    """Lấy nội dung trả lời từ message đã lưu. Bản mới lưu thêm dạng output[] (function_call, message...)."""
    if not message:
        return ""

    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()

    texts = []
    for output_item in message.get("output") or []:
        if output_item.get("type") != "message":
            continue
        for content_part in output_item.get("content") or []:
            if content_part.get("text"):
                texts.append(content_part["text"])
    return "\n".join(texts).strip()


class OpenWebUIClient:
    def __init__(self, settings: Settings, chat_repository: OpenWebUIChatRepository, http_client: httpx.AsyncClient):
        self._settings = settings
        self._chat_repository = chat_repository
        self._http_client = http_client
        self._cached_agent_info: AgentInfo | None = None
        self._agent_info_cached_at = 0.0

    # ------------------------------------------------------------------
    # API công khai
    # ------------------------------------------------------------------

    async def get_version(self) -> dict[str, Any]:
        return await self._request("GET", "/api/version")

    async def get_agent_info(self, force_refresh: bool = False) -> AgentInfo:
        cache_is_fresh = time.monotonic() - self._agent_info_cached_at < AGENT_INFO_CACHE_SECONDS
        if self._cached_agent_info and cache_is_fresh and not force_refresh:
            return self._cached_agent_info

        response = await self._request("GET", "/api/models")
        model = None
        for candidate in response.get("data", []):
            if candidate.get("id") == self._settings.openwebui_model:
                model = candidate
                break
        if model is None:
            raise OpenWebUIError(
                f'Không tìm thấy agent "{self._settings.openwebui_model}" trên OpenWebUI '
                "(kiểm tra OPENWEBUI_MODEL và quyền của API key)",
                is_retryable=False,
            )

        info = model.get("info") or {}
        meta = info.get("meta") or {}
        params = info.get("params") or {}
        agent_info = AgentInfo(
            model_id=model["id"],
            name=model.get("name", model["id"]),
            tool_ids=list(meta.get("toolIds") or []),
            knowledge_names=[item.get("name") or item.get("id") for item in meta.get("knowledge") or []],
            function_calling=params.get("function_calling") or "native",
        )
        self._cached_agent_info = agent_info
        self._agent_info_cached_at = time.monotonic()
        return agent_info

    async def ask(self, thread_id: str, thread_title: str | None, messages: list[dict[str, str]]) -> AgentAnswer:
        if self._settings.openwebui_mode == "completions":
            return await self._ask_with_completions(messages)
        return await self._ask_with_saved_chat(thread_id, thread_title, messages)

    # ------------------------------------------------------------------
    # Chế độ chat (tool chạy phía server)
    # ------------------------------------------------------------------

    async def _ask_with_saved_chat(
        self, thread_id: str, thread_title: str | None, messages: list[dict[str, str]]
    ) -> AgentAnswer:
        chat_id = await self._get_or_create_chat(thread_id, thread_title)
        assistant_message_id = str(uuid.uuid4())
        user_message_id = str(uuid.uuid4())
        last_message_content = messages[-1]["content"] if messages else ""

        request_body: dict[str, Any] = {
            "model": self._settings.openwebui_model,
            "chat_id": chat_id,
            "id": assistant_message_id,
            "stream": True,  # bắt buộc để OpenWebUI chạy vòng lặp tool phía server
            "messages": messages,
            "user_message": {
                "id": user_message_id,
                "role": "user",
                "content": last_message_content,
                "parentId": None,
                "childrenIds": [assistant_message_id],
                "timestamp": int(time.time()),
                "models": [self._settings.openwebui_model],
            },
        }
        tool_ids = await self._resolve_tool_ids()
        if tool_ids:
            request_body["tool_ids"] = tool_ids
        if self._settings.openwebui_enable_builtin_tools:
            request_body["session_id"] = f"zalo-bridge-{uuid.uuid4()}"

        started_at = time.monotonic()
        response = await self._request(
            "POST", "/api/chat/completions", json=request_body, timeout=self._settings.openwebui_timeout_seconds
        )
        if isinstance(response, dict) and response.get("queued"):
            raise OpenWebUIError("OpenWebUI xếp hàng tin nhắn vì chat đang bận")

        deadline = started_at + self._settings.openwebui_timeout_seconds
        answer_text = await self._wait_for_assistant_message(chat_id, assistant_message_id, deadline)
        logger.info(
            "Agent trả lời xong sau %.1fs (chat %s)", time.monotonic() - started_at, chat_id
        )
        return AgentAnswer(text=answer_text, chat_id=chat_id, message_id=assistant_message_id)

    async def _wait_for_assistant_message(self, chat_id: str, message_id: str, deadline: float) -> str:
        """Không có session_id: API trả về khi đã xong. Có session_id: chạy nền -> poll tới khi done."""
        while time.monotonic() < deadline:
            chat = await self._request("GET", f"/api/v1/chats/{chat_id}")
            stored_messages = ((chat or {}).get("chat") or {}).get("history", {}).get("messages", {})
            assistant_message = stored_messages.get(message_id)

            if assistant_message and assistant_message.get("error"):
                error_detail = assistant_message["error"].get("content") or str(assistant_message["error"])
                raise OpenWebUIError(f"Agent báo lỗi: {error_detail}")
            if assistant_message and assistant_message.get("done"):
                return extract_message_text(assistant_message)

            await asyncio.sleep(self._settings.openwebui_poll_interval_seconds)

        raise OpenWebUIError(f"OpenWebUI quá thời gian {self._settings.openwebui_timeout_seconds}s")

    async def _get_or_create_chat(self, thread_id: str, thread_title: str | None) -> str:
        today = date.today()
        if self._settings.openwebui_rotate_chat_daily:
            chat_key = f"{thread_id}:{today.isoformat()}"
            title = f"[Zalo] {thread_title or thread_id} - {today:%d/%m/%Y}"
        else:
            chat_key = thread_id
            title = f"[Zalo] {thread_title or thread_id}"

        existing_chat_id = await self._chat_repository.find_chat_id(chat_key)
        if existing_chat_id:
            return existing_chat_id

        response = await self._request(
            "POST",
            "/api/v1/chats/new",
            json={
                "chat": {
                    "title": title,
                    "models": [self._settings.openwebui_model],
                    "history": {"messages": {}, "currentId": None},
                    "messages": [],
                    "tags": [],
                }
            },
        )
        chat_id = (response or {}).get("id")
        if not chat_id:
            raise OpenWebUIError("Tạo chat trên OpenWebUI không trả về id")
        await self._chat_repository.save(chat_key, thread_id, chat_id)
        return chat_id

    # ------------------------------------------------------------------
    # Chế độ completions (OpenAI-compatible đơn giản)
    # ------------------------------------------------------------------

    async def _ask_with_completions(self, messages: list[dict[str, str]]) -> AgentAnswer:
        request_body: dict[str, Any] = {"model": self._settings.openwebui_model, "messages": messages, "stream": False}
        tool_ids = await self._resolve_tool_ids()
        if tool_ids:
            request_body["tool_ids"] = tool_ids

        response = await self._request(
            "POST", "/api/chat/completions", json=request_body, timeout=self._settings.openwebui_timeout_seconds
        )
        choices = (response or {}).get("choices") or [{}]
        message = choices[0].get("message") or {}
        if message.get("tool_calls") and not message.get("content"):
            raise OpenWebUIError(
                "Agent trả về tool_calls nhưng OpenWebUI không thực thi ở mode=completions. Đổi OPENWEBUI_MODE=chat.",
                is_retryable=False,
            )
        return AgentAnswer(text=(message.get("content") or "").strip())

    # ------------------------------------------------------------------
    # Hàm hỗ trợ
    # ------------------------------------------------------------------

    async def _resolve_tool_ids(self) -> list[str]:
        configured_tool_ids = self._settings.configured_tool_ids
        if len(configured_tool_ids) == 1 and configured_tool_ids[0].lower() == NO_TOOLS_KEYWORD:
            return []
        if configured_tool_ids:
            return configured_tool_ids
        agent_info = await self.get_agent_info()
        return agent_info.tool_ids

    async def _request(self, method: str, path: str, json: Any = None, timeout: float = 30) -> Any:
        url = f"{self._settings.openwebui_url.rstrip('/')}{path}"
        headers = {"Authorization": f"Bearer {self._settings.openwebui_api_key}"}
        try:
            response = await self._http_client.request(method, url, json=json, headers=headers, timeout=timeout)
        except httpx.HTTPError as error:
            raise OpenWebUIError(f"Không gọi được OpenWebUI {method} {path}: {error}") from error

        if response.status_code >= 400:
            is_retryable = response.status_code >= 500 or response.status_code == 429
            raise OpenWebUIError(
                f"OpenWebUI {method} {path} -> HTTP {response.status_code}: {response.text[:300]}",
                is_retryable=is_retryable,
            )
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            return response.text
