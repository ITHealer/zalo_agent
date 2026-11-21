import json

import httpx
import pytest

from app.core.config import Settings
from app.core.errors import OpenWebUIError
from app.services.openwebui_client import OpenWebUIClient, extract_message_text


class InMemoryChatRepository:
    def __init__(self):
        self.chat_ids: dict[str, str] = {}

    async def find_chat_id(self, chat_key: str) -> str | None:
        return self.chat_ids.get(chat_key)

    async def save(self, chat_key: str, thread_id: str, chat_id: str) -> None:
        self.chat_ids[chat_key] = chat_id


def make_settings(**overrides) -> Settings:
    values = {
        "openwebui_url": "http://owui.test",
        "openwebui_api_key": "sk-test",
        "openwebui_model": "tour-agent",
        "openwebui_poll_interval_seconds": 0.01,
        "openwebui_timeout_seconds": 2,
    }
    values.update(overrides)
    return Settings(**values)


MODELS_RESPONSE = {
    "data": [
        {
            "id": "tour-agent",
            "name": "Tour Agent",
            "info": {"meta": {"toolIds": ["lookup_tour"], "knowledge": [{"id": "k1", "name": "KB tour"}]}, "params": {}},
        }
    ]
}


class FakeOpenWebUI:
    """Giả lập các endpoint OpenWebUI mà client dùng, ghi lại request để kiểm tra."""

    def __init__(self, answer_after_polls: int = 1):
        self.requests: list[httpx.Request] = []
        self.completion_body: dict | None = None
        self.answer_after_polls = answer_after_polls
        self.poll_count = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/api/models":
            return httpx.Response(200, json=MODELS_RESPONSE)
        if path == "/api/v1/chats/new":
            return httpx.Response(200, json={"id": "chat-1"})
        if path == "/api/chat/completions":
            self.completion_body = json.loads(request.content)
            return httpx.Response(200, json={"status": True, "task_ids": ["t1"], "chat_id": "chat-1"})
        if path == "/api/v1/chats/chat-1":
            self.poll_count += 1
            message_id = self.completion_body["id"]
            is_done = self.poll_count >= self.answer_after_polls
            message = {"content": "Giá tour 3.990.000đ" if is_done else "", "done": is_done}
            return httpx.Response(200, json={"chat": {"history": {"messages": {message_id: message}}}})
        return httpx.Response(404)


async def test_chat_mode_sends_ids_and_tools_and_waits_for_answer():
    fake_server = FakeOpenWebUI(answer_after_polls=3)
    chat_repository = InMemoryChatRepository()
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake_server.handle)) as http_client:
        client = OpenWebUIClient(make_settings(), chat_repository, http_client)
        answer = await client.ask("g1", "Nhóm A", [{"role": "user", "content": "giá tour?"}])

    assert answer.text == "Giá tour 3.990.000đ"
    assert answer.chat_id == "chat-1"
    body = fake_server.completion_body
    assert body["chat_id"] == "chat-1"
    assert body["id"] == answer.message_id
    assert body["stream"] is True
    assert body["tool_ids"] == ["lookup_tour"]  # tự lấy từ agent
    assert body["session_id"].startswith("zalo-bridge-")
    assert body["user_message"]["childrenIds"] == [body["id"]]
    assert fake_server.poll_count == 3
    assert fake_server.requests[0].headers["Authorization"] == "Bearer sk-test"


async def test_chat_is_reused_for_same_group_on_same_day():
    fake_server = FakeOpenWebUI()
    chat_repository = InMemoryChatRepository()
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake_server.handle)) as http_client:
        client = OpenWebUIClient(make_settings(), chat_repository, http_client)
        await client.ask("g1", "Nhóm A", [{"role": "user", "content": "1"}])
        await client.ask("g1", "Nhóm A", [{"role": "user", "content": "2"}])

    created_chats = [request for request in fake_server.requests if request.url.path == "/api/v1/chats/new"]
    assert len(created_chats) == 1


async def test_builtin_tools_can_be_disabled_and_tools_overridden():
    fake_server = FakeOpenWebUI()
    settings = make_settings(openwebui_enable_builtin_tools=False, openwebui_tool_ids="tool_a, tool_b")
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake_server.handle)) as http_client:
        client = OpenWebUIClient(settings, InMemoryChatRepository(), http_client)
        await client.ask("g1", None, [{"role": "user", "content": "hi"}])

    assert "session_id" not in fake_server.completion_body
    assert fake_server.completion_body["tool_ids"] == ["tool_a", "tool_b"]


async def test_completions_mode_rejects_unexecuted_tool_calls():
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/models":
            return httpx.Response(200, json=MODELS_RESPONSE)
        tool_call = {"id": "c1", "type": "function", "function": {"name": "lookup_tour", "arguments": "{}"}}
        return httpx.Response(200, json={"choices": [{"message": {"content": None, "tool_calls": [tool_call]}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http_client:
        client = OpenWebUIClient(make_settings(openwebui_mode="completions"), InMemoryChatRepository(), http_client)
        with pytest.raises(OpenWebUIError) as error_info:
            await client.ask("g1", None, [{"role": "user", "content": "hi"}])

    assert error_info.value.is_retryable is False
    assert "OPENWEBUI_MODE=chat" in str(error_info.value)


async def test_unknown_agent_is_permanent_error():
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http_client:
        client = OpenWebUIClient(make_settings(), InMemoryChatRepository(), http_client)
        with pytest.raises(OpenWebUIError) as error_info:
            await client.get_agent_info()
    assert error_info.value.is_retryable is False


async def test_server_error_is_retryable_and_auth_error_is_not():
    status_code = 502

    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, text="oops")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http_client:
        client = OpenWebUIClient(make_settings(), InMemoryChatRepository(), http_client)
        with pytest.raises(OpenWebUIError) as server_error:
            await client.get_version()
        status_code = 401
        with pytest.raises(OpenWebUIError) as auth_error:
            await client.get_version()

    assert server_error.value.is_retryable is True
    assert auth_error.value.is_retryable is False


def test_extract_message_text_supports_output_items():
    assert extract_message_text({"content": " hi "}) == "hi"
    message = {
        "content": "",
        "output": [
            {"type": "function_call"},
            {"type": "message", "content": [{"type": "output_text", "text": "xin chào"}]},
        ],
    }
    assert extract_message_text(message) == "xin chào"
    assert extract_message_text(None) == ""
