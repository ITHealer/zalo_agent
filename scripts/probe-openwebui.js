// Kiểm tra kết nối tới agent trên OpenWebUI trước khi chạy bot:
//   npm run probe:openwebui -- "Câu hỏi thử"
// In ra version, cấu hình agent (tool/knowledge/function calling) và gửi 1 câu hỏi thử theo đúng cách bot sẽ gọi.
import { OpenWebUIClient } from '../src/openwebui.js';
import { config } from '../src/config.js';
import { migrate, pool } from '../src/db.js';

const question = process.argv[2] || 'Xin chào, bạn có thể giúp gì cho tôi?';
const c = new OpenWebUIClient();
try {
  console.log('OpenWebUI:', config.openwebui.baseUrl, await c.version());
  const info = await c.getModelInfo(true);
  console.log('Agent:', JSON.stringify(info, null, 2));
  console.log(`Mode: ${config.openwebui.mode} | builtin tools (KB): ${config.openwebui.enableBuiltinTools}`);
  await migrate();
  const t0 = Date.now();
  const res = await c.ask({
    threadId: 'probe',
    threadTitle: 'Probe kết nối',
    messages: [{ role: 'user', content: question }],
  });
  console.log(`\nTrả lời (${Date.now() - t0}ms):\n${res.text}\n`);
  if (res.chatId) console.log(`Xem chi tiết tool đã gọi trên UI: ${config.openwebui.baseUrl}/c/${res.chatId}`);
} catch (err) {
  console.error('LỖI:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
