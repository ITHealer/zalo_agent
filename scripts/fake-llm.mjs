// Fake OpenAI-compatible LLM dùng để test tích hợp OpenWebUI (không cần LLM thật).
// - Nếu request có `tools` và chưa có kết quả tool -> trả về tool_call gọi tool đầu tiên.
// - Nếu đã có message role=tool -> trả lời "TOOL_RESULT: <nội dung>".
// - Nếu là prompt chọn tool kiểu legacy của OpenWebUI -> trả JSON {"tool_calls":[...]}.
// - Ngược lại -> echo câu hỏi cuối và cho biết có context trong system prompt hay không.
// Chạy: node scripts/fake-llm.mjs   (mặc định cổng 11999)
import http from 'node:http';

const PORT = Number(process.env.FAKE_LLM_PORT || 11999);

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      return typeof m.content === 'string'
        ? m.content
        : (m.content || []).map((c) => c.text || '').join(' ');
    }
  }
  return '';
}

function decide(body) {
  const messages = body.messages || [];
  const allText = JSON.stringify(messages);
  const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
  if (toolMsg) {
    return { content: `TOOL_RESULT: ${typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content)}` };
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const fn = body.tools[0].function;
    return {
      tool_calls: [
        {
          id: 'call_' + Date.now(),
          type: 'function',
          function: { name: fn.name, arguments: JSON.stringify({ query: lastUserText(messages) }) },
        },
      ],
    };
  }
  // Prompt chọn tool kiểu legacy (OpenWebUI gửi danh sách tool trong system prompt)
  if (/Available Tools|tool_calls/i.test(allText) && /"name"\s*:\s*\\?"(\w+)/.test(allText)) {
    const m = allText.match(/\\"name\\"\s*:\s*\\"(\w+)\\"/) || allText.match(/"name"\s*:\s*"(\w+)"/);
    const name = m ? m[1] : 'unknown';
    return { content: JSON.stringify({ tool_calls: [{ name, parameters: { query: 'legacy' } }] }) };
  }
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  return { content: `ECHO: ${lastUserText(messages)} | system_has_tool_output=${/TOOL_OUTPUT_MARK/.test(allText)} | sys_len=${sys.length}` };
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'test' }] }));
  }
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    return res.end();
  }
  const body = JSON.parse(raw || '{}');
  if (process.env.FAKE_LLM_LOG) console.log('REQ', JSON.stringify({ stream: body.stream, tools: (body.tools || []).map((t) => t.function?.name), msgs: body.messages?.map((m) => m.role) }));
  const out = decide(body);
  const id = 'chatcmpl-' + Date.now();
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = out.tool_calls
      ? { role: 'assistant', tool_calls: out.tool_calls.map((t, index) => ({ index, ...t })) }
      : { role: 'assistant', content: out.content };
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: out.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id,
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: out.content ?? null, ...(out.tool_calls ? { tool_calls: out.tool_calls } : {}) },
          finish_reason: out.tool_calls ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
});

server.listen(PORT, () => console.log(`fake-llm listening on :${PORT}`));
