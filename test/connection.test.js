// Kiểm tra logic reconnect / watchdog với listener giả (không cần Zalo thật).
// Chạy: node --test --test-force-exit test/connection.test.js  (cần Postgres/Redis như .env, hoặc chỉ log cảnh báo)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.LOG_LEVEL ||= 'silent';
process.env.RECONNECT_MIN_MS = '50';
process.env.RECONNECT_MAX_MS = '200';
process.env.DUPLICATE_CONNECTION_BACKOFF_MS = '400';
process.env.WS_PING_INTERVAL_MS = '50';
process.env.WS_PONG_TIMEOUT_MS = '100';
process.env.SWEEP_INTERVAL_MS = '3600000';
process.env.SESSION_CHECK_INTERVAL_MS = '3600000';

const { ZaloConnection } = await import('../src/zalo/connection.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WebSocket giả: hỗ trợ ping/pong + terminate -> onclose(1006). */
class FakeWs extends EventEmitter {
  constructor(listener, { answerPong = true } = {}) {
    super();
    this.listener = listener;
    this.readyState = 1;
    this.answerPong = answerPong;
  }
  ping() {
    if (this.answerPong) setImmediate(() => this.emit('pong'));
  }
  terminate() {
    this.readyState = 3;
    this.listener.ws = null;
    this.listener.emit('closed', 1006, 'terminated');
  }
}

class FakeListener extends EventEmitter {
  constructor(opts) {
    super();
    this.ws = null;
    this.starts = 0;
    this.opts = opts;
  }
  start() {
    if (this.ws) throw new Error('Already started');
    this.starts++;
    this.ws = new FakeWs(this, this.opts);
    setImmediate(() => this.emit('connected'));
  }
  stop() {
    this.ws = null;
  }
  requestOldMessages() {}
  serverClose(code) {
    this.ws = null;
    this.emit('closed', code, '');
  }
}

function makeConn(listenerOpts) {
  const listener = new FakeListener(listenerOpts);
  const api = { listener, getOwnId: () => '1000', getAllGroups: async () => ({ gridVerMap: {} }) };
  let logins = 0;
  const conn = new ZaloConnection({
    loginFn: async () => {
      logins++;
      return api;
    },
    sessionAliveFn: async () => true,
  });
  return { conn, listener, logins: () => logins };
}

test('server đóng kết nối (1006) -> tự kết nối lại', async () => {
  const { conn, listener } = makeConn();
  await conn.start();
  await sleep(30);
  assert.equal(conn.state, 'connected');
  listener.serverClose(1006);
  assert.equal(conn.state, 'disconnected');
  await sleep(300);
  assert.equal(listener.starts, 2);
  assert.equal(conn.state, 'connected');
  await conn.stop();
});

test('kết nối lại không giới hạn số lần (khác retryOnClose của zca-js)', async () => {
  const { conn, listener } = makeConn();
  await conn.start();
  for (let i = 0; i < 8; i++) {
    await sleep(30);
    listener.serverClose(1006);
    await sleep(260);
  }
  assert.equal(listener.starts, 9);
  assert.equal(conn.state, 'connected');
  await conn.stop();
});

test('mã 3000 (phiên khác giành kết nối) -> chờ lâu hơn rồi mới kết nối lại', async () => {
  const { conn, listener } = makeConn();
  await conn.start();
  await sleep(30);
  listener.serverClose(3000);
  await sleep(250);
  assert.equal(listener.starts, 1, 'chưa được kết nối lại trong thời gian backoff');
  await sleep(300);
  assert.equal(listener.starts, 2);
  await conn.stop();
});

test('socket "chết lâm sàng" (không trả pong) -> cưỡng bức kết nối lại', async () => {
  const { conn, listener } = makeConn();
  await conn.start();
  await sleep(120); // nhận vài pong -> pongSupported
  assert.equal(conn.pongSupported, true);
  listener.ws.answerPong = false; // mạng treo, socket không đóng
  await sleep(600);
  assert.ok(listener.starts >= 2, 'phải kết nối lại sau khi mất pong');
  await conn.stop();
});

test('session chết -> đăng nhập lại trước khi kết nối socket', async () => {
  const { conn, listener, logins } = makeConn();
  let alive = true;
  conn.sessionAliveFn = async () => alive;
  await conn.start();
  await sleep(30);
  alive = false;
  listener.serverClose(1006);
  await sleep(300);
  assert.equal(logins(), 2);
  await conn.stop();
});
