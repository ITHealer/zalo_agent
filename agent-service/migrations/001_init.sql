-- Schema dùng chung giữa zalo-gateway (Node) và agent-service (Python).
-- agent-service sở hữu và chạy migration (service "migrate" trong docker-compose).

-- Toàn bộ tin nhắn nhận được (live + bù). msg_id là khoá chống trùng.
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
  trigger_kind  TEXT,                         -- mention | quote | mention_all | keyword | direct
  source        TEXT NOT NULL DEFAULT 'live', -- live | ws_backfill | http_sweep | self_sent
  raw           JSONB,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zalo_messages_thread_ts ON zalo_messages (thread_id, ts DESC);

-- Nhóm / hội thoại + con trỏ tin mới nhất đã lưu
CREATE TABLE IF NOT EXISTS zalo_threads (
  thread_id     TEXT PRIMARY KEY,
  thread_type   TEXT NOT NULL,
  name          TEXT,
  last_msg_id   TEXT,
  last_ts       BIGINT,
  last_swept_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mỗi tin cần bot trả lời là 1 job.
-- Vòng đời: queued -> processing -> answered -> sending -> sent
--           (hoặc skipped / failed)
-- gateway tạo job (queued); agent-service xử lý tới "sending"; gateway gửi xong -> "sent".
CREATE TABLE IF NOT EXISTS reply_jobs (
  msg_id               TEXT PRIMARY KEY REFERENCES zalo_messages(msg_id),
  thread_id            TEXT NOT NULL,
  thread_type          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued',
  attempts             INT NOT NULL DEFAULT 0,
  next_attempt_at      TIMESTAMPTZ,
  locked_until         TIMESTAMPTZ,
  question             TEXT,
  answer               TEXT,
  error                TEXT,
  skip_reason          TEXT,
  openwebui_chat_id    TEXT,
  openwebui_message_id TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reply_jobs_status ON reply_jobs (status, updated_at);

-- Tin bot cần gửi lên Zalo. agent-service ghi, zalo-gateway gửi.
-- Một câu trả lời dài được chia thành nhiều dòng (chunk_index 0, 1, 2...).
CREATE TABLE IF NOT EXISTS outbox_messages (
  id             BIGSERIAL PRIMARY KEY,
  reply_msg_id   TEXT NOT NULL REFERENCES reply_jobs(msg_id),
  kind           TEXT NOT NULL DEFAULT 'answer', -- answer | fallback
  chunk_index    INT NOT NULL,
  thread_id      TEXT NOT NULL,
  thread_type    TEXT NOT NULL,
  text           TEXT NOT NULL,
  quote_msg_id   TEXT,          -- quote tin gốc (thường chỉ chunk đầu)
  mention_uid    TEXT,          -- @ người hỏi ở đầu tin (thường chỉ chunk đầu)
  mention_length INT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts       INT NOT NULL DEFAULT 0,
  zalo_msg_id    TEXT,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  UNIQUE (reply_msg_id, kind, chunk_index)
);
CREATE INDEX IF NOT EXISTS outbox_messages_pending ON outbox_messages (status, created_at) WHERE status = 'pending';

-- Chat OpenWebUI tương ứng với mỗi nhóm (theo ngày nếu bật xoay vòng)
CREATE TABLE IF NOT EXISTS openwebui_chats (
  chat_key    TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Key/value: session đăng nhập Zalo...
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
