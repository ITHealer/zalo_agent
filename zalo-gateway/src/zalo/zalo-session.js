import fs from 'node:fs';
import path from 'node:path';
import { Zalo, LoginQRCallbackEventType } from 'zca-js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendAlert } from '../infrastructure/alert-notifier.js';

function createZaloClient() {
  // selfListen: nhận cả tin của chính bot để lưu đầy đủ lịch sử (không dùng để kích hoạt trả lời)
  return new Zalo({ selfListen: true, checkUpdate: false, logging: false });
}

/**
 * Quản lý đăng nhập Zalo:
 *  1. Ưu tiên session đã lưu trong Postgres (không cần người).
 *  2. Không có / hết hạn -> tạo QR, công bố qua onQrChanged để người vận hành quét.
 */
export class ZaloSessionManager {
  /**
   * @param {import('../repositories/state-repository.js').StateRepository} stateRepository
   * @param {(qr: {status: string, image?: string, generatedAt?: string}) => Promise<void>} onQrChanged
   */
  constructor(stateRepository, onQrChanged = async () => {}) {
    this.stateRepository = stateRepository;
    this.onQrChanged = onQrChanged;
    this.sessionKey = `zalo_session:${config.zalo.accountKey}`;
  }

  async login() {
    const apiFromSavedSession = await this.loginWithSavedSession();
    if (apiFromSavedSession) {
      return apiFromSavedSession;
    }
    return this.loginWithQrCode();
  }

  async loginWithSavedSession() {
    const savedSession = await this.stateRepository.get(this.sessionKey);
    if (!savedSession?.cookie || !savedSession?.imei) {
      return null;
    }
    try {
      const api = await createZaloClient().login({
        imei: savedSession.imei,
        cookie: savedSession.cookie,
        userAgent: savedSession.userAgent || config.zalo.userAgent,
        language: savedSession.language,
      });
      logger.info({ uid: api.getOwnId() }, 'Đăng nhập Zalo bằng session đã lưu: OK');
      return api;
    } catch (error) {
      logger.warn({ err: error.message }, 'Session đã lưu không dùng được, cần quét QR');
      await this.stateRepository.recordConnectionEvent('saved_session_invalid', { error: error.message });
      return null;
    }
  }

  async loginWithQrCode() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const qrFilePath = path.join(config.dataDir, 'qr.png');
    await sendAlert('Bot Zalo cần quét QR để đăng nhập', 'Mở API agent-service: GET /api/zalo/qr');

    const api = await createZaloClient().loginQR(
      { userAgent: config.zalo.userAgent, qrPath: qrFilePath },
      (event) => this.handleQrEvent(event, qrFilePath),
    );

    await this.onQrChanged({ status: 'logged_in' });
    await this.saveSession(api);
    await this.stateRepository.recordConnectionEvent('qr_login', { uid: api.getOwnId() });
    logger.info({ uid: api.getOwnId() }, 'Đăng nhập QR thành công, đã lưu session');
    return api;
  }

  async handleQrEvent(event, qrFilePath) {
    switch (event.type) {
      case LoginQRCallbackEventType.QRCodeGenerated:
        await event.actions.saveToFile(qrFilePath);
        await this.onQrChanged({
          status: 'waiting_scan',
          image: event.data.image,
          generatedAt: new Date().toISOString(),
        });
        logger.warn({ qrFilePath }, 'Đã tạo QR đăng nhập - quét bằng app Zalo của SỐ BOT');
        break;
      case LoginQRCallbackEventType.QRCodeExpired:
        logger.warn('QR hết hạn, tạo QR mới');
        event.actions.retry();
        break;
      case LoginQRCallbackEventType.QRCodeScanned:
        await this.onQrChanged({ status: 'scanned' });
        logger.info({ name: event.data.display_name }, 'QR đã được quét, chờ xác nhận trên điện thoại');
        break;
      case LoginQRCallbackEventType.QRCodeDeclined:
        logger.warn('Đăng nhập bị từ chối trên điện thoại, tạo QR mới');
        event.actions.retry();
        break;
      default:
        break;
    }
  }

  /** Lưu cookie/imei để lần khởi động sau không phải quét QR. */
  async saveSession(api) {
    const context = api.getContext();
    await this.stateRepository.set(this.sessionKey, {
      imei: context.imei,
      userAgent: context.userAgent,
      language: context.language,
      cookie: context.cookie.toJSON().cookies,
      uid: context.uid,
      savedAt: new Date().toISOString(),
    });
  }

  /** Kiểm tra session còn dùng được bằng 1 API HTTP nhẹ. */
  async isSessionAlive(api) {
    try {
      await api.fetchAccountInfo();
      return true;
    } catch (error) {
      logger.warn({ err: error.message }, 'Kiểm tra session thất bại');
      return false;
    }
  }
}
