import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { getOpenWebUIChat, saveOpenWebUIChat } from './db.js';

/**
 * Client gọi agent trên OpenWebUI.
 *
 * Vì sao không gọi /api/chat/completions "trơn"? (đã kiểm chứng trên OpenWebUI 0.13.x)
 *  - Gọi trơn {model, messages}: OpenWebUI BỎ QUA tool gắn trên agent.
 *  - Thêm tool_ids nhưng không có chat_id + message id: model trả tool_call về cho client,
 *    OpenWebUI KHÔNG thực thi tool.
 *  - Có chat_id (chat đã lưu) + id (assistant message id): OpenWebUI chạy vòng lặp tool phía server
 *    giống hệt khi dùng trên UI, kết quả được ghi vào chat -> đọc lại qua /api/v1/chats/{id}.
 *  - Có thêm session_id: bật builtin tools (gồm tra Knowledge Base gắn trên agent khi dùng function calling native).
 *    Khi đó API trả {task_ids} ngay và chạy nền -> ta poll chat tới khi message done.
 *
 * mode=chat (mặc định) làm theo cách trên. mode=completions là OpenAI-compatible đơn giản
 * (chỉ phù hợp agent KHÔNG cần tool, hoặc OpenWebUI bản cũ dùng function calling "default").
 */
export class OpenWebUIClient {
  constructor(opts = config.openwebui) {
    this.opts = opts;
    this.modelInfoCache = null;
  }

  async #req(method, path, body, { timeoutMs = 30000 } = {}) {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = new Error(`OpenWebUI ${method} ${path} -> HTTP ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
      err.status = res.status;
      err.retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
    return data;
  }

  async version() {
    return this.#req('GET', '/api/version');
  }

  /** Thông tin agent (toolIds, knowledge, function_calling...) từ /api/models. */
  async getModelInfo(force = false) {
    if (this.modelInfoCache && !force && Date.now() - this.modelInfoCache.at < 5 * 60 * 1000) {
      return this.modelInfoCache.value;
    }
    const data = await this.#req('GET', '/api/models');
    const model = (data?.data || []).find((m) => m.id === this.opts.model);
    if (!model) throw new Error(`Không tìm thấy model/agent "${this.opts.model}" trên OpenWebUI (kiểm tra OPENWEBUI_MODEL và quyền của API key)`);
    const meta = model.info?.meta || {};
    const value = {
      id: model.id,
      name: model.name,
      toolIds: meta.toolIds || [],
      knowledge: (meta.knowledge || []).map((k) => k.name || k.id),
      functionCalling: model.info?.params?.function_calling || 'native (mặc định)',
      builtinTools: meta.builtinTools || null,
    };
    this.modelInfoCache = { at: Date.now(), value };
    return value;
  }

  async #resolveToolIds() {
    const t = this.opts.toolIds;
    if (t.length === 1 && t[0].toLowerCase() === 'none') return [];
    if (t.length) return t;
    return (await this.getModelInfo()).toolIds;
  }

  /** Mỗi nhóm Zalo <-> 1 chat trên OpenWebUI (xoay theo ngày nếu bật) để đội vận hành xem lại được. */
  async ensureChat(threadId, title) {
    const day = new Date().toISOString().slice(0, 10);
    const key = this.opts.rotateChatDaily ? `${threadId}:${day}` : threadId;
    const existing = await getOpenWebUIChat(key);
    if (existing) return existing;
    const res = await this.#req('POST', '/api/v1/chats/new', {
      chat: {
        title: `[Zalo] ${title || threadId}${this.opts.rotateChatDaily ? ` - ${day.split('-').reverse().join('/')}` : ''}`,
        models: [this.opts.model],
        history: { messages: {}, currentId: null },
        messages: [],
        tags: [],
      },
    });
    if (!res?.id) throw new Error('Tạo chat OpenWebUI không trả về id');
    await saveOpenWebUIChat(key, threadId, res.id);
    return res.id;
  }

  async #readMessage(chatId, messageId) {
    const chat = await this.#req('GET', `/api/v1/chats/${chatId}`);
    return chat?.chat?.history?.messages?.[messageId] || null;
  }

  static messageText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string' && msg.content.trim()) return msg.content.trim();
    // Bản mới lưu kết quả dạng output[] (function_call, function_call_output, message)
    const out = Array.isArray(msg.output) ? msg.output : [];
    const texts = [];
    for (const item of out) {
      if (item.type !== 'message') continue;
      for (const c of item.content || []) if (c?.text) texts.push(c.text);
    }
    return texts.join('\n').trim();
  }

  /**
   * Hỏi agent. messages: [{role, content}] (OpenAI format), câu cuối là user.
   * @returns {Promise<{text: string, chatId?: string, messageId?: string}>}
   */
  async ask({ threadId, threadTitle, messages }) {
    if (this.opts.mode === 'completions') return this.#askCompletions(messages);
    return this.#askChat({ threadId, threadTitle, messages });
  }

  async #askCompletions(messages) {
    const toolIds = await this.#resolveToolIds();
    const body = { model: this.opts.model, messages, stream: false };
    if (toolIds.length) body.tool_ids = toolIds;
    const data = await this.#req('POST', '/api/chat/completions', body, { timeoutMs: this.opts.timeoutMs });
    const msg = data?.choices?.[0]?.message;
    if (msg?.tool_calls?.length && !msg.content) {
      const err = new Error(
        'Agent trả về tool_calls nhưng OpenWebUI không thực thi ở mode=completions. Đổi OPENWEBUI_MODE=chat.',
      );
      err.retryable = false;
      throw err;
    }
    return { text: (msg?.content || '').trim() };
  }

  async #askChat({ threadId, threadTitle, messages }) {
    const chatId = await this.ensureChat(threadId, threadTitle);
    const toolIds = await this.#resolveToolIds();
    const assistantId = randomUUID();
    const userMsgId = randomUUID();
    const last = messages[messages.length - 1];

    const body = {
      model: this.opts.model,
      chat_id: chatId,
      id: assistantId,
      stream: true, // bắt buộc để OpenWebUI chạy vòng lặp tool phía server
      messages,
      user_message: {
        id: userMsgId,
        role: 'user',
        content: typeof last?.content === 'string' ? last.content : '',
        parentId: null,
        childrenIds: [assistantId],
        timestamp: Math.floor(Date.now() / 1000),
        models: [this.opts.model],
      },
    };
    if (toolIds.length) body.tool_ids = toolIds;
    if (this.opts.enableBuiltinTools) body.session_id = `zalo-bridge-${randomUUID()}`;

    const started = Date.now();
    const res = await this.#req('POST', '/api/chat/completions', body, { timeoutMs: this.opts.timeoutMs });
    if (res && res.status === true && res.queued) {
      throw Object.assign(new Error('OpenWebUI xếp hàng tin nhắn vì chat đang bận'), { retryable: true });
    }

    // Đồng bộ (không session_id): đã xong khi API trả về. Bất đồng bộ (có session_id): poll tới khi done.
    while (Date.now() - started < this.opts.timeoutMs) {
      const msg = await this.#readMessage(chatId, assistantId);
      if (msg?.error) {
        const e = msg.error.content || JSON.stringify(msg.error);
        throw Object.assign(new Error(`Agent lỗi: ${e}`), { retryable: true });
      }
      if (msg?.done) {
        const text = OpenWebUIClient.messageText(msg);
        logger.debug({ chatId, assistantId, ms: Date.now() - started }, 'OpenWebUI trả lời xong');
        return { text, chatId, messageId: assistantId };
      }
      await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs));
    }
    throw Object.assign(new Error(`OpenWebUI quá thời gian ${this.opts.timeoutMs}ms`), { retryable: true });
  }
}
