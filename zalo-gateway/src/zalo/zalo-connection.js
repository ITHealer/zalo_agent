import WebSocket from 'ws';
import { ThreadType } from 'zca-js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendAlert } from '../infrastructure/alert-notifier.js';

const CLOSE_CODE_DUPLICATE_CONNECTION = 3000;
const CLOSE_CODE_KICKED = 3003;
const ALERT_AFTER_FAILED_ATTEMPTS = 5;

/**
 * Quản lý vòng đời kết nối WebSocket tới Zalo:
 *  - đăng nhập (qua ZaloSessionManager)
 *  - tự kết nối lại với backoff, không giới hạn số lần
 *    (không dùng retryOnClose của zca-js vì bộ đếm của nó không bao giờ reset)
 *  - phát hiện kết nối "chết lâm sàng" bằng ping/pong và thời gian im lặng
 *  - sau mỗi lần kết nối: xin lại tin cũ qua WebSocket + quét bù qua HTTP
 */
export class ZaloConnection {
  /**
   * @param {object} dependencies
   * @param {import('./zalo-session.js').ZaloSessionManager} dependencies.sessionManager
   * @param {import('../services/message-ingestor.js').MessageIngestor} dependencies.messageIngestor
   * @param {import('../repositories/message-repository.js').MessageRepository} dependencies.messageRepository
   * @param {import('../repositories/state-repository.js').StateRepository} dependencies.stateRepository
   * @param {import('./history-sweeper.js').HistorySweeper} [dependencies.historySweeper]
   */
  constructor({ sessionManager, messageIngestor, messageRepository, stateRepository, historySweeper }) {
    this.sessionManager = sessionManager;
    this.messageIngestor = messageIngestor;
    this.messageRepository = messageRepository;
    this.stateRepository = stateRepository;
    this.historySweeper = historySweeper || null;

    this.api = null;
    this.botUid = null;
    this.state = 'idle'; // idle | connecting | connected | disconnected | stopped
    this.isStopping = false;
    this.failedAttempts = 0;
    this.reconnectTimer = null;
    this.intervalTimers = [];

    this.lastConnectedAt = 0;
    this.lastFrameAt = 0;
    this.lastMessageAt = 0;
    this.serverSupportsPong = false;
    this.pingSentAt = 0; // 0 = không chờ pong

    this.stats = { connects: 0, disconnects: 0, lastCloseCode: null };
  }

  getStatus() {
    const toIso = (timestamp) => (timestamp ? new Date(timestamp).toISOString() : null);
    return {
      state: this.state,
      botUid: this.botUid,
      lastConnectedAt: toIso(this.lastConnectedAt),
      lastFrameAt: toIso(this.lastFrameAt),
      lastMessageAt: toIso(this.lastMessageAt),
      serverSupportsPong: this.serverSupportsPong,
      ...this.stats,
    };
  }

  async start() {
    this.isStopping = false;
    await this.loginAndBindListener();
    this.openSocket();

    const { pingIntervalMs, sessionCheckIntervalMs } = config.connection;
    this.intervalTimers.push(setInterval(() => this.checkLiveness(), pingIntervalMs));
    this.intervalTimers.push(setInterval(() => this.checkSession(), sessionCheckIntervalMs));
  }

  async stop() {
    this.isStopping = true;
    this.state = 'stopped';
    clearTimeout(this.reconnectTimer);
    for (const timer of this.intervalTimers) {
      clearInterval(timer);
    }
    this.intervalTimers = [];
    try {
      this.api?.listener.stop();
    } catch {
      // listener có thể đã dừng
    }
  }

  // ---------------------------------------------------------------------------
  // Đăng nhập và gắn sự kiện
  // ---------------------------------------------------------------------------

  async loginAndBindListener() {
    const api = await this.sessionManager.login();
    this.api = api;
    this.botUid = String(api.getOwnId());

    const listener = api.listener;
    listener.on('connected', () => this.handleConnected());
    listener.on('cipher_key', () => this.handleSocketReady());
    listener.on('closed', (code, reason) => this.handleClosed(code, reason));
    listener.on('error', (error) => logger.warn({ err: error?.message || String(error) }, 'Listener báo lỗi'));
    listener.on('message', (message) => this.handleIncomingMessage(message, 'live'));
    listener.on('old_messages', (messages, threadType) => {
      const threadLabel = threadType === ThreadType.Group ? 'group' : 'user';
      logger.info({ count: messages.length, threadType: threadLabel }, 'Nhận tin cũ (ws backfill)');
      for (const message of messages) {
        this.handleIncomingMessage(message, 'ws_backfill');
      }
    });
    logger.info({ botUid: this.botUid }, 'Đã gắn listener Zalo');
  }

  handleIncomingMessage(message, source) {
    this.lastMessageAt = Date.now();
    this.messageIngestor.ingest(message, this.botUid, source).catch((error) => {
      // Không mất tin: lần quét bù tiếp theo sẽ lưu lại tin này
      logger.error({ err: error, msgId: message?.data?.msgId }, 'Lưu tin lỗi, sẽ được quét bù lại');
    });
  }

  // ---------------------------------------------------------------------------
  // Mở socket / kết nối lại
  // ---------------------------------------------------------------------------

  openSocket() {
    if (this.isStopping) {
      return;
    }
    this.state = 'connecting';
    try {
      this.api.listener.start({ retryOnClose: false });
    } catch (error) {
      logger.error({ err: error.message }, 'Không mở được socket');
      this.scheduleReconnect(null);
      return;
    }
    this.watchRawSocket(this.api.listener.ws);
  }

  /** Theo dõi frame và pong trên socket gốc (thuộc tính nội bộ của zca-js, có kiểm tra an toàn). */
  watchRawSocket(rawSocket) {
    if (!rawSocket || typeof rawSocket.on !== 'function') {
      return;
    }
    rawSocket.on('message', () => {
      this.lastFrameAt = Date.now();
    });
    rawSocket.on('pong', () => {
      this.serverSupportsPong = true;
      this.pingSentAt = 0;
      this.lastFrameAt = Date.now();
    });
  }

  handleConnected() {
    this.state = 'connected';
    this.failedAttempts = 0;
    this.stats.connects += 1;
    this.lastConnectedAt = Date.now();
    this.lastFrameAt = Date.now();
    this.pingSentAt = 0;
    logger.info('Đã kết nối WebSocket Zalo');
    this.stateRepository.recordConnectionEvent('connected');
  }

  /** Đã có cipher key = socket giải mã được tin -> xin lại tin cũ để lấp khoảng mất kết nối. */
  async handleSocketReady() {
    try {
      const latestGroupMsgId = await this.messageRepository.findLatestReceivedMessageId('group');
      this.api.listener.requestOldMessages(ThreadType.Group, latestGroupMsgId);
      if (config.storage.storeDirectMessages) {
        const latestUserMsgId = await this.messageRepository.findLatestReceivedMessageId('user');
        this.api.listener.requestOldMessages(ThreadType.User, latestUserMsgId);
      }
      logger.info({ latestGroupMsgId }, 'Đã yêu cầu tin cũ qua WebSocket');
    } catch (error) {
      logger.warn({ err: error.message }, 'Yêu cầu tin cũ qua WebSocket lỗi');
    }

    if (this.historySweeper) {
      // Quét HTTP ngay sau khi (re)connect để chắc chắn không sót tin
      setTimeout(() => this.historySweeper.sweepAllGroups().catch(() => {}), 5000);
    }
  }

  handleClosed(code, reason) {
    this.state = 'disconnected';
    this.stats.disconnects += 1;
    this.stats.lastCloseCode = code;
    logger.warn({ code, reason }, 'WebSocket Zalo bị đóng');
    this.stateRepository.recordConnectionEvent('closed', { code, reason });
    if (!this.isStopping) {
      this.scheduleReconnect(code);
    }
  }

  calculateReconnectDelay(closeCode) {
    const { reconnectMinDelayMs, reconnectMaxDelayMs, duplicateConnectionDelayMs } = config.connection;

    const isKickedByAnotherSession = closeCode === CLOSE_CODE_DUPLICATE_CONNECTION || closeCode === CLOSE_CODE_KICKED;
    if (isKickedByAnotherSession) {
      return duplicateConnectionDelayMs;
    }

    // Exponential backoff có jitter: 2s, 4s, 8s... tối đa reconnectMaxDelayMs
    const exponent = Math.min(this.failedAttempts - 1, 10);
    const baseDelay = Math.min(reconnectMaxDelayMs, reconnectMinDelayMs * 2 ** exponent);
    const jitter = Math.random() * (baseDelay / 2);
    return Math.round(baseDelay / 2 + jitter);
  }

  scheduleReconnect(closeCode) {
    clearTimeout(this.reconnectTimer);
    const isKickedByAnotherSession =
      closeCode === CLOSE_CODE_DUPLICATE_CONNECTION || closeCode === CLOSE_CODE_KICKED;

    if (isKickedByAnotherSession) {
      sendAlert(
        'Bot Zalo bị đá khỏi phiên (có Zalo Web/PC khác đang mở bằng số bot)',
        `Mã ${closeCode}. Hãy đóng các phiên Zalo Web/PC của số bot.`,
      );
    } else {
      this.failedAttempts += 1;
      if (this.failedAttempts === ALERT_AFTER_FAILED_ATTEMPTS) {
        sendAlert('Bot Zalo mất kết nối liên tục', `Đã thử ${this.failedAttempts} lần, mã đóng cuối: ${closeCode}`);
      }
    }

    const delayMs = this.calculateReconnectDelay(closeCode);
    logger.info({ delayMs, failedAttempts: this.failedAttempts }, 'Lên lịch kết nối lại');
    this.reconnectTimer = setTimeout(() => this.reconnect(), delayMs);
  }

  async reconnect() {
    if (this.isStopping) {
      return;
    }
    try {
      // Session chết thì mở lại socket cũng vô ích -> đăng nhập lại trước
      const sessionIsAlive = await this.sessionManager.isSessionAlive(this.api);
      if (!sessionIsAlive) {
        await sendAlert('Session Zalo hết hạn, đang đăng nhập lại', 'Nếu không có session hợp lệ sẽ cần quét QR');
        this.api.listener.removeAllListeners();
        await this.loginAndBindListener();
      }
      this.openSocket();
    } catch (error) {
      logger.error({ err: error.message }, 'Kết nối lại lỗi');
      this.scheduleReconnect(null);
    }
  }

  /** Chủ động đóng socket để kích hoạt chu trình kết nối lại + bù tin. */
  forceReconnect(reason) {
    logger.warn({ reason }, 'Cưỡng bức kết nối lại');
    this.stateRepository.recordConnectionEvent('force_reconnect', { reason });
    const rawSocket = this.api?.listener?.ws;
    if (rawSocket && typeof rawSocket.terminate === 'function') {
      rawSocket.terminate(); // -> sự kiện closed (1006) -> scheduleReconnect
    } else {
      this.scheduleReconnect(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Giám sát
  // ---------------------------------------------------------------------------

  checkLiveness() {
    if (this.state !== 'connected') {
      return;
    }
    const rawSocket = this.api?.listener?.ws;
    if (!rawSocket || rawSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const now = Date.now();
    const { pongTimeoutMs, idleReconnectMs } = config.connection;

    const isWaitingForPong = this.pingSentAt > 0;
    if (this.serverSupportsPong && isWaitingForPong && now - this.pingSentAt > pongTimeoutMs) {
      this.forceReconnect('Không nhận được pong');
      return;
    }

    // Chỉ dùng ngưỡng im lặng khi server không trả pong (có pong đã đủ chứng minh socket còn sống)
    const lastActivityAt = Math.max(this.lastFrameAt, this.lastConnectedAt);
    if (!this.serverSupportsPong && now - lastActivityAt > idleReconnectMs) {
      this.forceReconnect(`Không nhận được dữ liệu trong ${Math.round(idleReconnectMs / 1000)}s`);
      return;
    }

    try {
      if (!isWaitingForPong) {
        this.pingSentAt = now;
      }
      rawSocket.ping();
    } catch (error) {
      logger.warn({ err: error.message }, 'Gửi ping lỗi');
    }
  }

  async checkSession() {
    if (!this.api || this.isStopping) {
      return;
    }
    const sessionIsAlive = await this.sessionManager.isSessionAlive(this.api);
    if (sessionIsAlive) {
      // Zalo có thể làm mới cookie -> lưu lại để lần sau không phải quét QR
      await this.sessionManager.saveSession(this.api).catch(() => {});
    } else if (this.state === 'connected') {
      this.forceReconnect('Session không còn hợp lệ');
    }
  }
}
