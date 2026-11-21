# Zalo Agent (PoC)

Bot chạy trên **một số Zalo cá nhân**, được thêm vào các nhóm Zalo thông thường (không cần GMF/OA):

- **Lưu toàn bộ tin nhắn** của các nhóm vào Postgres.
- Khi bot **được @tag** (hoặc có người reply vào tin của bot), bot hỏi **agent trên OpenWebUI**
  (tool và Knowledge Base của agent đều được chạy) rồi trả lời lại trong nhóm, kèm quote tin gốc và @ người hỏi.
- Thiết kế để **không mất tin**: tự reconnect, watchdog phát hiện kết nối "chết lâm sàng",
  xin lại tin cũ qua WebSocket và quét bù định kỳ qua HTTP. Tin được lưu idempotent theo `msg_id`.

> ⚠️ Dùng thư viện không chính thức [`zca-js`](https://github.com/RFS-ADRENO/zca-js) (giả lập Zalo Web).
> Zalo có thể khoá số bot. Hãy dùng **sim riêng cho bot** và xin ý kiến Legal về điều khoản Zalo
> và Nghị định 13/2023/NĐ-CP trước khi lưu tin nhắn khách hàng.

## Kiến trúc

```
Zalo WS ──► ZaloConnection ──► ingest() ──► Postgres (zalo_messages, ON CONFLICT DO NOTHING)
   ▲          │  reconnect/backoff             │ tag bot?
   │          │  ping/pong watchdog            ▼
   │          │  ws backfill (requestOldMessages)   reply_jobs (DB = nguồn sự thật)
   │          └─ HTTP sweep (getCloudMessage) mỗi 5'│
   │                                            ▼
   │                                   BullMQ/Redis (jobId = msgId)
   │                                            ▼
   └──── sendMessage(quote + mention) ◄── Worker ──► OpenWebUI agent (chat mode, tool chạy phía server)
```

| Nguy cơ mất tin | Cách xử lý |
|---|---|
| `retryOnClose` của zca-js chỉ thử một số lần, bộ đếm không reset, sau đó dừng hẳn | Tự quản lý reconnect, không giới hạn số lần, backoff 2s→60s |
| Socket còn mở nhưng không nhận gì ("half-open") | Gửi ping WebSocket mỗi 30s, không có pong sau 15s thì terminate và kết nối lại |
| Có phiên Zalo Web/PC khác mở bằng số bot (mã 3000/3003) | Chờ 2 phút rồi giành lại + gửi cảnh báo |
| Tin đến lúc đang mất kết nối | Sau mỗi lần kết nối: `requestOldMessages` + quét HTTP từng nhóm tới khi gặp tin đã có |
| Process crash giữa chừng | Lưu tin vào DB trước rồi mới enqueue. Mỗi phút có job đối soát DB ↔ Redis |
| Session/cookie hết hạn | Kiểm tra định kỳ, tự đăng nhập lại bằng session đã lưu. Nếu không được thì cảnh báo để quét QR |
| Chạy nhầm 2 instance cùng số (đá nhau liên tục) | Redis lock: chỉ 1 listener cho mỗi số |
| Trả lời trùng khi retry | Lưu câu trả lời trước khi gửi, gửi theo từng phần và nhớ phần đã gửi |

## Cách gọi OpenWebUI (đã kiểm chứng trên 0.13.4)

| Cách gọi `/api/chat/completions` | Kết quả |
|---|---|
| `{model, messages}` | Tool gắn trên agent **bị bỏ qua** |
| `+ tool_ids` | Model trả `tool_calls` về client, OpenWebUI **không thực thi** |
| `+ chat_id + id` (chat đã lưu), `stream: true` | **Tool được thực thi phía server**, kết quả ghi vào chat |
| `+ session_id` | Bật thêm builtin tools (tra **Knowledge Base** của agent), chạy nền → poll chat |

Bot dùng cách cuối (`OPENWEBUI_MODE=chat`). Mỗi nhóm Zalo ứng với một chat `[Zalo] <tên nhóm> - dd/mm/yyyy`
trên OpenWebUI, nên đội vận hành có thể mở ra xem agent đã gọi tool gì.

## Chạy

### 1. Chuẩn bị
- Một **sim/số Zalo riêng cho bot**, thêm số này vào các nhóm cần hỗ trợ.
- API key OpenWebUI (Settings > Account > API Keys) của tài khoản có quyền dùng agent và các tool của agent.
- Docker + Docker Compose.

### 2. Cấu hình
```bash
cp .env.example .env
```
Điền 4 biến bắt buộc: `OPENWEBUI_URL`, `OPENWEBUI_API_KEY`, `OPENWEBUI_MODEL`, `POSTGRES_PASSWORD`.

### 3. Kiểm tra kết nối agent trước
```bash
docker compose run --rm zalo-agent node scripts/probe-openwebui.js "Câu hỏi thử"
```
Lệnh này in ra tool/KB của agent và câu trả lời thử, gọi đúng theo cách bot sẽ gọi.

### 4. Chạy bot và đăng nhập
```bash
docker compose up -d --build
```
Mở `http://localhost:3000/qr` (hoặc file `data/qr.png`) rồi **quét bằng app Zalo của số bot**.
Session được lưu vào Postgres, các lần khởi động sau không cần quét lại.

```bash
curl -s localhost:3000/health
```

### Chạy không dùng Docker
Cần Node 20+, Postgres 14+, Redis 6+:
```bash
npm ci && npm start
```

## Vận hành

- **Không mở Zalo Web/PC bằng số bot.** Chỉ để app trên điện thoại giữ số sống.
- Lấy group id để cấu hình `REPLY_GROUP_ALLOWLIST`:
  `SELECT thread_id, name, last_ts FROM zalo_threads;`
- Tin bot đã trả lời / lỗi: `SELECT status, count(*) FROM reply_jobs GROUP BY 1;`
- Lịch sử kết nối: `SELECT * FROM connection_events ORDER BY id DESC LIMIT 50;`
- Tin được bù nhờ quét: `SELECT count(*) FROM zalo_messages WHERE source <> 'live';`
- Tách listener và worker (khi cần scale worker): `ROLE=listener` (đúng 1 instance) + `ROLE=worker` (nhiều instance).

## Test

```bash
npm test                 # unit + logic reconnect/watchdog
npm run test:e2e         # cần Postgres, Redis, OpenWebUI (xem đầu file test/e2e.test.js)
node scripts/fake-llm.mjs   # LLM giả lập có gọi tool, dùng làm backend OpenWebUI khi test
```

## Cấu trúc

```
src/
  index.js            khởi động theo ROLE, shutdown an toàn
  config.js           đọc .env
  zalo/session.js     đăng nhập (session đã lưu → QR), lưu cookie
  zalo/connection.js  reconnect, watchdog, ws backfill, HTTP sweep
  zalo/normalize.js   chuẩn hoá tin, phát hiện tag bot
  ingest.js           lưu tin idempotent + tạo reply job
  queue.js            BullMQ + đối soát job
  worker.js           gọi agent, gửi trả lời (quote + mention, chia tin dài)
  openwebui.js        client OpenWebUI (chat mode / completions mode)
  prompt.js           dựng ngữ cảnh nhóm, làm sạch markdown
  lock.js             khoá 1 listener / 1 số
  http.js             /health, /qr
migrations/           schema Postgres
```
