// Kiểm tra logic kết nối lại / giám sát với listener giả (không cần Zalo, Postgres hay Redis).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.LOG_LEVEL ||= 'silent';
process.env.RECONNECT_MIN_MS = '50';
process.env.RECONNECT_MAX_MS = '200';
process.env.DUPLICATE_CONNECTION_BACKOFF_MS = '400';
process.env.WS_PING_INTERVAL_MS = '50';
process.env.WS_PONG_TIMEOUT_MS = '100';
process.env.SESSION_CHECK_INTERVAL_MS = '3600000';

const { ZaloConnection } = await import('../src/zalo/zalo-connection.js');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** WebSocket giả: hỗ trợ ping/pong và terminate (-> closed 1006). */
class FakeRawSocket extends EventEmitter {
  constructor(listener) {
    super();
    this.listener = listener;
    this.readyState = 1; // OPEN
    this.answersPing = true;
  }

  ping() {
    if (this.answersPing) {
      setImmediate(() => this.emit('pong'));
    }
  }

  terminate() {
    this.readyState = 3;
    this.listener.ws = null;
    this.listener.emit('closed', 1006, 'terminated');
  }
}

class FakeListener extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.startCount = 0;
  }

  start() {
    if (this.ws) {
      throw new Error('Already started');
    }
    this.startCount += 1;
    this.ws = new FakeRawSocket(this);
    setImmediate(() => this.emit('connected'));
  }

  stop() {
    this.ws = null;
  }

  requestOldMessages() {}

  closeFromServer(code) {
    this.ws = null;
    this.emit('closed', code, '');
  }
}

function createConnectionWithFakes() {
  const listener = new FakeListener();
  const fakeApi = { listener, getOwnId: () => '1000' };
  const sessionManager = {
    loginCount: 0,
    sessionIsAlive: true,
    async login() {
      this.loginCount += 1;
      return fakeApi;
    },
    async isSessionAlive() {
      return this.sessionIsAlive;
    },
    async saveSession() {},
  };
  const connection = new ZaloConnection({
    sessionManager,
    messageIngestor: { ingest: async () => ({ isNew: true }) },
    messageRepository: { findLatestReceivedMessageId: async () => null },
    stateRepository: { recordConnectionEvent: async () => {} },
  });
  return { connection, listener, sessionManager };
}

test('server đóng kết nối (1006) -> tự kết nối lại', async () => {
  const { connection, listener } = createConnectionWithFakes();
  await connection.start();
  await sleep(30);
  assert.equal(connection.state, 'connected');

  listener.closeFromServer(1006);
  assert.equal(connection.state, 'disconnected');
  await sleep(300);
  assert.equal(listener.startCount, 2);
  assert.equal(connection.state, 'connected');
  await connection.stop();
});

test('kết nối lại không giới hạn số lần (khác retryOnClose của zca-js)', async () => {
  const { connection, listener } = createConnectionWithFakes();
  await connection.start();
  for (let round = 0; round < 8; round += 1) {
    await sleep(30);
    listener.closeFromServer(1006);
    await sleep(260);
  }
  assert.equal(listener.startCount, 9);
  assert.equal(connection.state, 'connected');
  await connection.stop();
});

test('mã 3000 (phiên khác giành kết nối) -> chờ lâu hơn rồi mới kết nối lại', async () => {
  const { connection, listener } = createConnectionWithFakes();
  await connection.start();
  await sleep(30);
  listener.closeFromServer(3000);
  await sleep(250);
  assert.equal(listener.startCount, 1, 'chưa được kết nối lại trong thời gian chờ');
  await sleep(300);
  assert.equal(listener.startCount, 2);
  await connection.stop();
});

test('socket "chết lâm sàng" (không trả pong) -> cưỡng bức kết nối lại', async () => {
  const { connection, listener } = createConnectionWithFakes();
  await connection.start();
  await sleep(120);
  assert.equal(connection.serverSupportsPong, true);

  listener.ws.answersPing = false; // mạng treo nhưng socket không đóng
  await sleep(600);
  assert.ok(listener.startCount >= 2, 'phải kết nối lại sau khi mất pong');
  await connection.stop();
});

test('session hết hạn -> đăng nhập lại trước khi mở socket', async () => {
  const { connection, listener, sessionManager } = createConnectionWithFakes();
  await connection.start();
  await sleep(30);

  sessionManager.sessionIsAlive = false;
  listener.closeFromServer(1006);
  await sleep(300);
  assert.equal(sessionManager.loginCount, 2);
  await connection.stop();
});
