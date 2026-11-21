-- Toàn bộ tin nhắn nhận được (live + backfill). msg_id là khoá chống trùng.
CREATE TABLE IF NOT EXISTS zalo_messages (
  msg_id        TEXT PRIMARY KEY,
  cli_msg_id    TEXT,
  thread_id     TEXT NOT NULL,
  thread_type   TEXT NOT NULL CHECK (thread_type IN ('group', 'user')),
  sender_uid    TEXT NOT NULL,
  sender_name   TEXT,
  msg_type      TEXT,
  text          TEXT,
  content       JSONB,
  mentions      JSONB,
  quote         JSONB,
  ts            BIGINT NOT NULL,
  is_self       BOOLEAN NOT NULL DEFAULT FALSE,
  triggers_bot  BOOLEAN NOT NULL DEFAULT FALSE,
  source        TEXT NOT NULL DEFAULT 'live', -- live | ws_backfill | http_sweep | self_sent
  raw           JSONB,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zalo_messages_thread_ts ON zalo_messages (thread_id, ts DESC);
CREATE INDEX IF NOT EXISTS zalo_messages_triggers ON zalo_messages (triggers_bot) WHERE triggers_bot;

-- Thông tin nhóm + con trỏ tin mới nhất đã lưu
CREATE TABLE IF NOT EXISTS zalo_threads (
  thread_id     TEXT PRIMARY KEY,
  thread_type   TEXT NOT NULL,
  name          TEXT,
  last_msg_id   TEXT,
  last_ts       BIGINT,
  last_swept_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mỗi tin cần trả lời là một job. Trạng thái nằm ở DB (nguồn sự thật), Redis/BullMQ chỉ để phân phối.
CREATE TABLE IF NOT EXISTS reply_jobs (
  msg_id               TEXT PRIMARY KEY REFERENCES zalo_messages(msg_id),
  thread_id            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued', -- queued | processing | answered | sent | skipped | failed
  attempts             INT NOT NULL DEFAULT 0,
  question             TEXT,
  answer               TEXT,
  error                TEXT,
  skip_reason          TEXT,
  openwebui_chat_id    TEXT,
  openwebui_message_id TEXT,
  sent_msg_ids         JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reply_jobs_status ON reply_jobs (status, updated_at);

-- Chat OpenWebUI tương ứng với mỗi nhóm (theo ngày nếu bật xoay vòng)
CREATE TABLE IF NOT EXISTS openwebui_chats (
  chat_key    TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Key/value: session đăng nhập Zalo, trạng thái...
CREATE TABLE IF NOT EXISTS bot_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nhật ký kết nối để soi sự cố
CREATE TABLE IF NOT EXISTS connection_events (
  id         BIGSERIAL PRIMARY KEY,
  event      TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
