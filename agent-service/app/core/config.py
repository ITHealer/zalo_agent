from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Cấu hình đọc từ biến môi trường (hoặc file .env)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)

    # --- Hạ tầng ---
    database_url: str = "postgres://zalo:zalo@localhost:5432/zalo_agent"
    redis_url: str = "redis://localhost:6379"
    log_level: str = "INFO"

    # --- API quản trị ---
    # Bắt buộc gửi kèm header X-API-Token (hoặc ?token=) khi gọi /api/*. Để trống = khoá toàn bộ /api/*.
    admin_api_token: str = ""
    alert_webhook_url: str = ""

    # --- OpenWebUI ---
    openwebui_url: str = "http://localhost:8080"
    openwebui_api_key: str = ""
    openwebui_model: str = Field(default="", validation_alias=AliasChoices("OPENWEBUI_MODEL", "OPENWEBUI_MODEL_ID"))
    # chat: chạy tool phía server (khuyến nghị) | completions: OpenAI-compatible đơn giản (agent không dùng tool)
    openwebui_mode: Literal["chat", "completions"] = "chat"
    # Bật builtin tools: cần khi agent tra Knowledge Base với function calling native
    openwebui_enable_builtin_tools: bool = True
    # Trống = tự lấy tool đang gắn trên agent. "none" = không dùng tool.
    openwebui_tool_ids: str = ""
    openwebui_timeout_seconds: float = 180
    openwebui_poll_interval_seconds: float = 1.5
    # Mỗi nhóm Zalo <-> 1 chat trên OpenWebUI, đổi chat mới mỗi ngày để chat không phình to
    openwebui_rotate_chat_daily: bool = True
    # Số lượt hỏi-đáp trước đó của bot trong nhóm gửi kèm làm ngữ cảnh
    openwebui_history_turns: int = 4

    # --- Soạn câu trả lời ---
    reply_context_messages: int = 30
    reply_chunk_size: int = 1800
    reply_mention_sender: bool = True
    reply_fallback_text: str = ""
    reply_max_attempts: int = 4
    reply_retry_base_delay_seconds: int = 10

    # --- Worker ---
    worker_concurrency: int = 3
    reconcile_interval_seconds: int = 30
    processing_lock_seconds: int = 300

    @property
    def configured_tool_ids(self) -> list[str]:
        return [tool_id.strip() for tool_id in self.openwebui_tool_ids.split(",") if tool_id.strip()]

    def missing_required_settings(self) -> list[str]:
        missing = []
        if not self.openwebui_api_key:
            missing.append("OPENWEBUI_API_KEY")
        if not self.openwebui_model:
            missing.append("OPENWEBUI_MODEL (hoặc OPENWEBUI_MODEL_ID)")
        return missing


@lru_cache
def get_settings() -> Settings:
    return Settings()
