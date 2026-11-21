import { EventEmitter } from 'node:events';
import { ThreadType } from 'zca-js';
import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ingest } from '../ingest.js';
import { getLatestMessageId, logConnectionEvent, getThread, markThreadSwept, setThreadName } from '../db.js';
import { alert } from '../alert.js';
import { login, isSessionAlive, saveCredentials } from './session.js';
import { msgIdLte } from './normalize.js';

const R = config.reliability;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Quản lý vòng đời kết nối Zalo:
 *  - đăng nhập (session đã lưu -> QR)
 *  - tự reconnect với backoff (không dùng retryOnClose của zca-js vì bộ đếm không bao giờ reset)
 *  - phát hiện kết nối "chết lâm sàng" (ping/pong + idle)
 *  - backfill qua WebSocket sau mỗi lần kết nối lại + quét bù định kỳ qua HTTP (getCloudMessage)
 */
export class ZaloConnection extends EventEmitter {
  /**
   * @param {object} [deps] inject để test: loginFn, sessionAliveFn
   */
  constructor(deps = {}) {
    super();
    this.loginFn = deps.loginFn || login;
    this.sessionAliveFn = deps.sessionAliveFn || isSessionAlive;
    this.api = null;
    this.botUid = null;
    this.state = 'idle'; // idle | connecting | connected | disconnected | stopped
    this.attempt = 0;
    this.stopping = false;
    this.forceReconnect = false;
    this.reconnectTimer = null;
    this.timers = [];
    this.lastFrameAt = 0;
    this.lastMessageAt = 0;
    this.lastConnectedAt = 0;
    this.lastSweepAt = 0;
    this.sweeping = false;
    this.pongSupported = false;
    this.awaitingPongSince = 0;
    this.stats = { connects: 0, disconnects: 0, sweeps: 0, sweepErrors: 0, lastCloseCode: null };
  }

  status() {
    return {
      state: this.state,
      botUid: this.botUid,
      lastConnectedAt: this.lastConnectedAt ? new Date(this.lastConnectedAt).toISOString() : null,
      lastFrameAt: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      lastSweepAt: this.lastSweepAt ? new Date(this.lastSweepAt).toISOString() : null,
      pongSupported: this.pongSupported,
      ...this.stats,
    };
  }

  async start() {
    this.stopping = false;
    await this.#loginAndBind();
    this.#connect();
    this.timers.push(setInterval(() => this.#livenessTick(), R.pingIntervalMs));
    this.timers.push(setInterval(() => this.sweep().catch((err) => logger.error({ err }, 'sweep lỗi')), R.sweepIntervalMs));
    this.timers.push(setInterval(() => this.#sessionTick(), R.sessionCheckIntervalMs));
  }

  async stop() {
    this.stopping = true;
    this.state = 'stopped';
    clearTimeout(this.reconnectTimer);
    this.timers.forEach(clearInterval);
    this.timers = [];
    try {
      this.api?.listener.stop();
    } catch {
      /* ignore */
    }
  }

  // ---------- login / listener binding ----------

  async #loginAndBind() {
    const api = await this.loginFn();
    this.api = api;
    this.botUid = String(api.getOwnId());
    const l = api.listener;

    l.on('connected', () => this.#onConnected());
    l.on('cipher_key', () => this.#onReady());
    l.on('closed', (code, reason) => this.#onClosed(code, reason));
    l.on('error', (err) => logger.warn({ err: err?.message || String(err) }, 'listener error'));
    l.on('message', (msg) => this.#handle(msg, 'live'));
    l.on('old_messages', (msgs, type) => {
      logger.info({ count: msgs.length, type: type === ThreadType.Group ? 'group' : 'user' }, 'nhận old_messages (ws backfill)');
      for (const m of msgs) this.#handle(m, 'ws_backfill');
    });
    l.on('group_event', (ev) => {
      // Bot được thêm vào nhóm mới / đổi tên nhóm... -> quét lại sớm
      if (['join', 'update'].includes(String(ev.type).toLowerCase())) this.lastSweepAt = 0;
    });
    logger.info({ botUid: this.botUid }, 'đã bind listener');
  }

  #handle(msg, source) {
    this.lastMessageAt = Date.now();
    ingest(msg, this.botUid, source).catch((err) =>
      logger.error({ err, msgId: msg?.data?.msgId }, 'ingest lỗi (tin sẽ được quét bù lại)'),
    );
  }

  // ---------- connect / reconnect ----------

  #connect() {
    if (this.stopping) return;
    this.state = 'connecting';
    try {
      this.api.listener.start({ retryOnClose: false });
    } catch (err) {
      logger.error({ err: err.message }, 'listener.start lỗi');
      this.#scheduleReconnect(null);
      return;
    }
    // Gắn theo dõi frame/pong trên socket gốc (thuộc tính private của zca-js, có kiểm tra an toàn)
    const ws = this.api.listener.ws;
    if (ws && typeof ws.on === 'function') {
      ws.on('message', () => (this.lastFrameAt = Date.now()));
      ws.on('pong', () => {
        this.pongSupported = true;
        this.awaitingPongSince = 0;
        this.lastFrameAt = Date.now();
      });
    }
  }

  #onConnected() {
    this.state = 'connected';
    this.attempt = 0;
    this.stats.connects++;
    this.lastConnectedAt = Date.now();
    this.lastFrameAt = Date.now();
    this.awaitingPongSince = 0;
    logger.info('WebSocket Zalo đã kết nối');
    logConnectionEvent('connected');
  }

  /** Có cipher key = socket đã sẵn sàng giải mã -> xin lại tin cũ để lấp khoảng trống. */
  async #onReady() {
    try {
      const lastGroup = await getLatestMessageId('group');
      const lastUser = await getLatestMessageId('user');
      this.api.listener.requestOldMessages(ThreadType.Group, lastGroup);
      if (config.zalo.storeDirectMessages) this.api.listener.requestOldMessages(ThreadType.User, lastUser);
      logger.info({ lastGroup, lastUser }, 'đã yêu cầu ws backfill');
    } catch (err) {
      logger.warn({ err: err.message }, 'ws backfill lỗi');
    }
    // Quét HTTP ngay sau khi (re)connect để chắc chắn không sót
    setTimeout(() => this.sweep().catch((err) => logger.error({ err }, 'sweep lỗi')), 5000);
  }

  #onClosed(code, reason) {
    this.state = 'disconnected';
    this.stats.disconnects++;
    this.stats.lastCloseCode = code;
    logger.warn({ code, reason }, 'WebSocket Zalo bị đóng');
    logConnectionEvent('closed', { code, reason });
    if (this.stopping) return;
    this.#scheduleReconnect(code);
  }

  #scheduleReconnect(code) {
    clearTimeout(this.reconnectTimer);
    let delay;
    if (code === 3000 || code === 3003) {
      // Có phiên Zalo Web/PC khác dùng chung số bot -> chờ lâu rồi mới giành lại
      delay = R.duplicateConnectionBackoffMs;
      alert(
        'Bot Zalo bị đá khỏi phiên (có Zalo Web/PC khác đang mở bằng số bot)',
        `Mã ${code}. Đóng các phiên Zalo Web/PC của số bot. Tự kết nối lại sau ${Math.round(delay / 1000)}s.`,
      );
    } else {
      this.attempt++;
      const base = Math.min(R.reconnectMaxMs, R.reconnectMinMs * 2 ** Math.min(this.attempt - 1, 10));
      delay = Math.round(base / 2 + Math.random() * (base / 2));
      if (this.attempt === 5) alert('Bot Zalo mất kết nối liên tục', `Đã thử ${this.attempt} lần, mã đóng cuối ${code}`);
    }
    logger.info({ delayMs: delay, attempt: this.attempt }, 'lên lịch kết nối lại');
    this.reconnectTimer = setTimeout(() => this.#reconnect(), delay);
  }

  async #reconnect() {
    if (this.stopping) return;
    try {
      // Phiên đăng nhập chết thì kết nối lại socket vô ích -> đăng nhập lại
      if (!(await this.sessionAliveFn(this.api))) {
        await alert('Session Zalo hết hạn, đang đăng nhập lại', 'Nếu không có session hợp lệ sẽ cần quét QR');
        try {
          this.api.listener.removeAllListeners();
        } catch {
          /* ignore */
        }
        await this.#loginAndBind();
      }
      this.#connect();
    } catch (err) {
      logger.error({ err: err.message }, 'reconnect lỗi');
      this.#scheduleReconnect(null);
    }
  }

  /** Cưỡng bức đóng socket để kích hoạt chu trình reconnect + backfill. */
  forceRestart(why) {
    logger.warn({ why }, 'cưỡng bức kết nối lại');
    logConnectionEvent('force_restart', { why });
    const ws = this.api?.listener?.ws;
    if (ws && typeof ws.terminate === 'function') ws.terminate(); // -> onclose(1006) -> reconnect
    else this.#scheduleReconnect(null);
  }

  // ---------- liveness ----------

  #livenessTick() {
    if (this.state !== 'connected') return;
    const ws = this.api?.listener?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();

    if (this.pongSupported && this.awaitingPongSince && now - this.awaitingPongSince > R.pongTimeoutMs) {
      return this.forceRestart('không nhận được pong');
    }
    // Chỉ dùng ngưỡng "im lặng" khi server không hỗ trợ pong (pong đã là bằng chứng socket còn sống)
    if (!this.pongSupported && now - Math.max(this.lastFrameAt, this.lastConnectedAt) > R.idleReconnectMs) {
      return this.forceRestart(`không có frame nào trong ${Math.round(R.idleReconnectMs / 1000)}s`);
    }
    try {
      if (!this.awaitingPongSince) this.awaitingPongSince = now;
      ws.ping();
    } catch (err) {
      logger.warn({ err: err.message }, 'ws.ping lỗi');
    }
  }

  async #sessionTick() {
    if (!this.api || this.stopping) return;
    if (await this.sessionAliveFn(this.api)) {
      // cookie có thể được Zalo làm mới -> lưu lại để lần khởi động sau không phải quét QR
      await saveCredentials(this.api).catch(() => {});
    } else if (this.state === 'connected') {
      this.forceRestart('session không còn hợp lệ');
    }
  }

  // ---------- HTTP sweep (lưới an toàn) ----------

  async #listGroups() {
    const allow = config.zalo.storeGroupAllowlist.length ? config.zalo.storeGroupAllowlist : null;
    if (allow) return allow;
    const res = await this.api.getAllGroups();
    return Object.keys(res.gridVerMap || {});
  }

  /**
   * Với mỗi nhóm: lấy trang tin mới nhất (50 tin) qua cloud message API, lùi trang tới khi
   * gặp tin đã có trong DB (con trỏ last_msg_id) hoặc chạm giới hạn trang. Mọi tin đi qua ingest() nên idempotent.
   */
  async sweep() {
    if (!this.api || this.sweeping || this.stopping) return;
    this.sweeping = true;
    const started = Date.now();
    let inserted = 0;
    try {
      const groups = await this.#listGroups();
      for (const gid of groups) {
        if (this.stopping) break;
        try {
          inserted += await this.#sweepGroup(gid);
          await markThreadSwept(gid);
        } catch (err) {
          this.stats.sweepErrors++;
          logger.warn({ gid, err: err.message, code: err.code }, 'sweep nhóm lỗi');
        }
        await sleep(R.sweepDelayBetweenGroupsMs);
      }
      this.stats.sweeps++;
      this.lastSweepAt = Date.now();
      logger.info({ groups: groups.length, inserted, ms: Date.now() - started }, 'sweep xong');
      if (inserted > 0) logger.warn({ inserted }, 'sweep đã bù các tin bị sót từ WebSocket');
    } finally {
      this.sweeping = false;
    }
  }

  async #sweepGroup(gid) {
    const thread = await getThread(gid);
    if (!thread?.name) {
      try {
        const info = await this.api.getGroupInfo(gid);
        const name = info?.gridInfoMap?.[gid]?.name;
        if (name) await setThreadName(gid, 'group', name);
      } catch {
        /* tên nhóm không bắt buộc */
      }
    }
    const cursor = thread?.last_msg_id || null;
    // Lần đầu thấy nhóm: chỉ lấy 1 trang gần nhất, không kéo toàn bộ lịch sử
    const maxPages = cursor ? R.sweepMaxPagesPerGroup : 1;
    let inserted = 0;
    let page = await this.api.getCloudMessage(gid);
    for (let i = 0; i < maxPages; i++) {
      const msgs = page.groupMsgs || [];
      for (const m of msgs) {
        const r = await ingest(m, this.botUid, 'http_sweep');
        if (r.stored) inserted++;
      }
      if (!cursor || !msgs.length || !page.hasMore) break;
      const oldest = msgs.reduce((min, m) => (msgIdLte(m.data.msgId, min) ? m.data.msgId : min), msgs[0].data.msgId);
      if (msgIdLte(oldest, cursor)) break; // đã chạm vùng tin đã có
      if (i === maxPages - 1) {
        logger.warn({ gid }, 'sweep chạm giới hạn trang - có thể còn tin cũ hơn chưa bù');
        break;
      }
      await sleep(500);
      page = await this.api.getCloudMessage(gid, page.lastMsgId, { isOld: page.isOld });
    }
    return inserted;
  }
}
