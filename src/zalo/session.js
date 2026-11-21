import fs from 'node:fs';
import path from 'node:path';
import { Zalo, LoginQRCallbackEventType } from 'zca-js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getState, setState, logConnectionEvent } from '../db.js';
import { alert } from '../alert.js';

const stateKey = () => `zalo_session:${config.zalo.accountKey}`;

/** QR hiện tại (base64 PNG) để xem qua HTTP /qr khi cần đăng nhập lại. */
export const qrState = { image: null, generatedAt: null, status: 'idle' };

function newZalo() {
  return new Zalo({ selfListen: true, checkUpdate: false, logging: false });
}

export async function saveCredentials(api) {
  const ctx = api.getContext();
  const cookies = ctx.cookie.toJSON().cookies;
  await setState(stateKey(), {
    imei: ctx.imei,
    userAgent: ctx.userAgent,
    language: ctx.language,
    cookie: cookies,
    uid: ctx.uid,
    savedAt: new Date().toISOString(),
  });
}

export async function loginWithSaved() {
  const saved = await getState(stateKey());
  if (!saved?.cookie || !saved?.imei) return null;
  try {
    const api = await newZalo().login({
      imei: saved.imei,
      cookie: saved.cookie,
      userAgent: saved.userAgent || config.zalo.userAgent,
      language: saved.language,
    });
    logger.info({ uid: api.getOwnId() }, 'đăng nhập Zalo bằng session đã lưu: OK');
    return api;
  } catch (err) {
    logger.warn({ err: err.message }, 'session đã lưu không dùng được, cần quét QR');
    await logConnectionEvent('saved_session_invalid', { error: err.message });
    return null;
  }
}

async function loginWithQR() {
  const qrPath = path.join(config.dataDir, 'qr.png');
  fs.mkdirSync(config.dataDir, { recursive: true });
  qrState.status = 'waiting_scan';
  await alert('Bot Zalo cần quét QR để đăng nhập', `Mở http://<host>:${config.httpPort}/qr hoặc file ${qrPath}`);
  const api = await newZalo().loginQR({ userAgent: config.zalo.userAgent, qrPath }, async (event) => {
    switch (event.type) {
      case LoginQRCallbackEventType.QRCodeGenerated:
        qrState.image = event.data.image;
        qrState.generatedAt = new Date().toISOString();
        qrState.status = 'waiting_scan';
        await event.actions.saveToFile(qrPath);
        logger.warn({ qrPath }, 'QR đăng nhập đã tạo - quét bằng app Zalo của SỐ BOT');
        break;
      case LoginQRCallbackEventType.QRCodeExpired:
        logger.warn('QR hết hạn, tạo QR mới');
        qrState.status = 'expired';
        event.actions.retry();
        break;
      case LoginQRCallbackEventType.QRCodeScanned:
        qrState.status = 'scanned';
        logger.info({ name: event.data.display_name }, 'QR đã được quét, chờ xác nhận trên điện thoại');
        break;
      case LoginQRCallbackEventType.QRCodeDeclined:
        qrState.status = 'declined';
        logger.warn('Đăng nhập bị từ chối trên điện thoại, tạo QR mới');
        event.actions.retry();
        break;
      default:
        break;
    }
  });
  qrState.status = 'logged_in';
  qrState.image = null;
  await saveCredentials(api);
  await logConnectionEvent('qr_login', { uid: api.getOwnId() });
  logger.info({ uid: api.getOwnId() }, 'đăng nhập QR thành công, đã lưu session');
  return api;
}

/** Ưu tiên session đã lưu, nếu không được thì QR (chờ người quét). */
export async function login() {
  return (await loginWithSaved()) || (await loginWithQR());
}

/** Kiểm tra session còn dùng được bằng 1 API HTTP nhẹ. */
export async function isSessionAlive(api) {
  try {
    await api.fetchAccountInfo();
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, 'kiểm tra session thất bại');
    return false;
  }
}
