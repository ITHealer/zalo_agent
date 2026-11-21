# Zalo Agent

Bot chạy trên **một số Zalo cá nhân**, được thêm vào các nhóm Zalo thông thường (không cần GMF/OA):

- **Lưu toàn bộ tin nhắn** của các nhóm vào Postgres.
- Khi bot **được @tag** (hoặc có người reply vào tin của bot), bot hỏi **agent trên OpenWebUI**
  (tool và Knowledge Base của agent đều được chạy) rồi trả lời trong nhóm, kèm quote tin gốc và @ người hỏi.
- Thiết kế để **không mất tin**: tự kết nối lại, phát hiện kết nối treo, xin lại tin cũ và quét bù định kỳ.

> ⚠️ Kết nối Zalo dùng thư viện không chính thức [`zca-js`](https://github.com/RFS-ADRENO/zca-js).
> Zalo có thể khoá số bot. Dùng **sim riêng cho bot** và xin ý kiến Legal về điều khoản Zalo và
> Nghị định 13/2023/NĐ-CP trước khi lưu tin nhắn khách hàng.

## Kiến trúc

Hệ thống gồm 2 service, giao tiếp qua **Postgres (nguồn sự thật) + Redis Streams (báo có việc)**:

| Service | Ngôn ngữ | Trách nhiệm |
|---|---|---|
| `zalo-gateway/` | Node.js | Chỉ làm việc với Zalo: đăng nhập, giữ kết nối, lưu tin, gửi tin từ outbox. Mỏng, ít thay đổi. |
| `agent-service/` | Python + FastAPI | Logic nghiệp vụ: dựng ngữ cảnh, gọi agent OpenWebUI, soạn câu trả lời, API quản trị, migration. |

```
                 ┌──────────────────── zalo-gateway (Node) ────────────────────┐
 Zalo WebSocket ─┤ ZaloConnection ─► MessageIngestor ─► zalo_messages, reply_jobs │
 (+ quét bù HTTP)│                                    └─► stream zalo:reply-requests ──┐
                 │ OutboxSender ◄── stream zalo:outbox ◄──────────────────────────┐  │
                 └──────┬─────────────────────────────────────────────────────┘  │  │
                        ▼ sendMessage (quote + mention)                           │  │
                      Zalo                                                        │  │
                 ┌──────────────────── agent-service (Python) ──────────────────┐ │  │
                 │ ReplyWorker ◄────────────────────────────────────────────────┼─┼──┘
                 │   └─► ReplyService: ngữ cảnh nhóm ─► OpenWebUI ─► outbox_messages ─┘
                 │ JobReconciler (đối soát định kỳ)    FastAPI: /health, /api/*  │
                 └──────────────────────────────────────────────────────────────┘
```

### Vòng đời một câu hỏi
1. **gateway** nhận tin có tag bot, lưu vào `zalo_messages`, tạo `reply_jobs` (`queued`) và báo qua `zalo:reply-requests`.
2. **agent-service** giành job (`processing`), hỏi agent, lưu câu trả lời (`answered`), ghi vào `outbox_messages`
   (`sending`) và báo qua `zalo:outbox`.
3. **gateway** gửi từng phần lên Zalo, đánh dấu từng phần đã gửi, xong thì chuyển job sang `sent`.

Redis Stream chỉ để "báo có việc". Trạng thái thật nằm ở Postgres, nên mất thông báo cũng không mất việc:
bộ đối soát ở cả hai service sẽ tìm và xử lý tiếp.

### Chống mất tin / trả lời trùng

| Rủi ro | Cách xử lý |
|---|---|
| `retryOnClose` của zca-js chỉ thử một số lần, bộ đếm không reset, sau đó dừng hẳn | Gateway tự quản lý kết nối lại, không giới hạn số lần, backoff 2s→60s |
| Socket còn mở nhưng không nhận được gì ("half-open") | Ping WebSocket mỗi 30s, không có pong sau 15s thì đóng và kết nối lại |
| Có phiên Zalo Web/PC khác mở bằng số bot (mã 3000/3003) | Chờ 2 phút rồi giành lại + gửi cảnh báo |
| Tin đến lúc đang mất kết nối | Sau mỗi lần kết nối: xin lại tin cũ qua WebSocket + quét HTTP từng nhóm |
| Process chết giữa chừng / mất thông báo Redis | Ghi DB trước, báo sau. `JobReconciler` (Python) và bộ đối soát outbox (Node) quét DB định kỳ |
| Nhận trùng 1 tin (live + bù) | `msg_id` là khoá chính, mỗi job được "giành" nguyên tử bằng `UPDATE ... RETURNING` |
| Retry sau khi đã gửi một phần | Từng phần outbox được đánh dấu `sent` ngay sau khi gửi |
| Agent lỗi tạm thời | Thử lại với backoff (10s, 20s, 40s...), lần cuối lỗi thì đánh dấu `failed` + cảnh báo + câu dự phòng (tuỳ chọn) |
| 2 gateway cùng số | Khoá Redis: chỉ 1 gateway nghe WebSocket cho mỗi số |

### Cách gọi OpenWebUI (đã kiểm chứng trên 0.13.4)

| Cách gọi `/api/chat/completions` | Kết quả |
|---|---|
| `{model, messages}` | Tool gắn trên agent **bị bỏ qua** |
| `+ tool_ids` | Model trả `tool_calls` về client, OpenWebUI **không thực thi** |
| `+ chat_id + id` (chat đã lưu), `stream: true` | **Tool được thực thi phía server**, kết quả ghi vào chat |
| `+ session_id` | Bật thêm builtin tools (tra **Knowledge Base** của agent), chạy nền → poll chat |

agent-service dùng cách cuối (`OPENWEBUI_MODE=chat`). Mỗi nhóm Zalo ứng với một chat
`[Zalo] <tên nhóm> - dd/mm/yyyy` trên OpenWebUI, nên mở ra là xem được agent đã gọi tool gì.

## Cấu trúc mã nguồn

```
agent-service/                    Python 3.12+, FastAPI
  app/
    main.py                       tạo FastAPI app, lifespan khởi động worker
    container.py                  composition root: khởi tạo & nối mọi thành phần
    core/                         config (pydantic-settings), contracts, errors, logging
    infrastructure/               database (pool + migration), redis_streams, alert, gateway_status
    repositories/                 truy cập bảng: reply_jobs, zalo_messages, outbox, threads, openwebui_chats
    services/                     openwebui_client, prompt_builder, text_formatter, reply_service
    workers/                      reply_worker (đọc stream), job_reconciler (đối soát)
    api/                          dependencies (token), routes/ (health, zalo, reply_jobs, threads)
    schemas/                      response models
    cli/                          migrate, probe_openwebui
  migrations/                     schema SQL dùng chung cho cả 2 service
  tests/unit/                     test không cần hạ tầng

zalo-gateway/                     Node.js 20+
  src/
    index.js                      composition root
    config.js, contracts.js       cấu hình; hợp đồng chung với agent-service
    infrastructure/               postgres, redis, redis-streams, listener-lock, alert-notifier
    repositories/                 message, thread, reply-job, outbox, state
    zalo/                         zalo-session (đăng nhập), zalo-connection (kết nối lại/giám sát),
                                  history-sweeper (quét bù), message-normalizer (hàm thuần)
    services/                     message-ingestor, outbox-sender, gateway-status-publisher
    http/                         health-server
  test/                           unit, kết nối lại, tích hợp toàn hệ thống

tools/fake-llm.mjs                LLM giả lập có gọi tool (dùng làm backend OpenWebUI khi test)
```

Quy ước: phân lớp `infrastructure → repositories → services → workers/api`, phụ thuộc truyền qua constructor
(dễ thay bằng bản giả khi test). Toàn bộ khởi tạo nằm ở composition root (`container.py`, `index.js`).
Hợp đồng giữa 2 service (tên stream, key Redis, trạng thái) nằm ở `core/contracts.py` ↔ `src/contracts.js`,
sửa một bên phải sửa cả bên kia.

## Triển khai

Cần một **máy chủ chạy liên tục** có Docker (VPS hoặc server nội bộ, nên đặt ở Việt Nam).

```bash
git clone https://github.com/ITHealer/zalo_agent.git && cd zalo_agent
```
```bash
cp .env.example .env
```
Điền 5 biến bắt buộc trong `.env`: `OPENWEBUI_URL`, `OPENWEBUI_API_KEY`, `OPENWEBUI_MODEL`,
`POSTGRES_PASSWORD` (tự đặt), `ADMIN_API_TOKEN` (tự đặt).

Kiểm tra agent trước khi chạy bot:
```bash
docker compose run --rm agent-service python -m app.cli.probe_openwebui "Câu hỏi thử"
```

Chạy:
```bash
docker compose up -d --build
```

Đăng nhập Zalo: mở `http://localhost:8000/api/zalo/qr?token=<ADMIN_API_TOKEN>` trên server
(hoặc qua SSH tunnel `ssh -L 8000:localhost:8000 user@server`) và **quét bằng app Zalo của số bot**.
Session được lưu vào Postgres, các lần khởi động sau không cần quét lại.

## API quản trị (agent-service)

Tài liệu tương tác: `http://localhost:8000/docs`. Mọi `/api/*` cần header `X-API-Token: <ADMIN_API_TOKEN>`.

| Endpoint | Mô tả |
|---|---|
| `GET /health` | Postgres, Redis, trạng thái gateway (không cần token) |
| `GET /api/zalo/status` | Trạng thái kết nối Zalo |
| `GET /api/zalo/qr?token=...` | Trang QR đăng nhập |
| `GET /api/threads` | Các nhóm đã ghi nhận (lấy group id cho `REPLY_GROUP_ALLOWLIST`) |
| `GET /api/threads/{id}/messages` | Tin nhắn đã lưu của nhóm |
| `GET /api/reply-jobs?status=failed` | Danh sách câu hỏi bot đã/đang trả lời, đếm theo trạng thái |
| `GET /api/reply-jobs/{msg_id}` | Chi tiết: câu hỏi, câu trả lời, các tin đã gửi |
| `POST /api/reply-jobs/{msg_id}/retry` | Thử lại job `failed`/`skipped` |

## Vận hành

- **Không mở Zalo Web/PC bằng số bot**, nếu không bot sẽ bị đá khỏi phiên.
- Log: `docker compose logs -f zalo-gateway agent-service`
- Lịch sử kết nối: `SELECT * FROM connection_events ORDER BY id DESC LIMIT 50;`
- Tin được bù nhờ quét: `SELECT source, count(*) FROM zalo_messages GROUP BY 1;`
- Scale: `agent-service` chạy được nhiều bản (job được giành nguyên tử). `zalo-gateway` chỉ **1 bản cho mỗi số**.

## Phát triển & test

```bash
# agent-service
cd agent-service && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
pytest tests/unit

# zalo-gateway
cd zalo-gateway && npm ci
npm test                      # unit + logic kết nối lại/giám sát
INTEGRATION=1 npm run test:integration   # cần Postgres, Redis, OpenWebUI và agent-service đang chạy
```
