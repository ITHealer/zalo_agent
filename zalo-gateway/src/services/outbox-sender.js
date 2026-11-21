import { ThreadType } from 'zca-js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { OUTBOX_STATUS } from '../contracts.js';
import { sendAlert } from '../infrastructure/alert-notifier.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function randomBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * Math.max(0, maximum - minimum));
}

function toZaloThreadType(threadType) {
  return threadType === 'group' ? ThreadType.Group : ThreadType.User;
}

/** Dựng object quote theo định dạng zca-js từ bản ghi raw của tin gốc. */
export function buildQuoteFromRawMessage(rawMessage) {
  if (!rawMessage) {
    return undefined;
  }
  return {
    content: rawMessage.content,
    msgType: rawMessage.msgType,
    propertyExt: rawMessage.propertyExt,
    uidFrom: rawMessage.uidFrom,
    msgId: rawMessage.msgId,
    cliMsgId: rawMessage.cliMsgId,
    ts: rawMessage.ts,
    ttl: rawMessage.ttl ?? 0,
  };
}

/**
 * Gửi các câu trả lời agent-service đã ghi vào bảng outbox_messages lên Zalo.
 *  - Gửi đúng thứ tự từng phần, có độ trễ ngẫu nhiên + trạng thái "đang soạn tin".
 *  - Mỗi phần gửi xong được đánh dấu ngay -> chạy lại không gửi trùng.
 *  - Bộ đối soát định kỳ gửi nốt các phần còn treo (vd gateway vừa khởi động lại).
 */
export class OutboxSender {
  /**
   * @param {object} dependencies
   * @param {() => {api: object, botUid: string}} dependencies.getZaloSession
   * @param {import('../repositories/outbox-repository.js').OutboxRepository} dependencies.outboxRepository
   * @param {import('../repositories/reply-job-repository.js').ReplyJobRepository} dependencies.replyJobRepository
   * @param {import('../repositories/message-repository.js').MessageRepository} dependencies.messageRepository
   */
  constructor({ getZaloSession, outboxRepository, replyJobRepository, messageRepository }) {
    this.getZaloSession = getZaloSession;
    this.outboxRepository = outboxRepository;
    this.replyJobRepository = replyJobRepository;
    this.messageRepository = messageRepository;
    this.repliesInProgress = new Set();
    this.lastSentAt = 0;
    this.reconcileTimer = null;
    this.stats = { sentMessages: 0, failedMessages: 0 };
  }

  startReconciler() {
    this.reconcileTimer = setInterval(() => this.sendStalePendingReplies(), config.sending.reconcileIntervalMs);
  }

  stopReconciler() {
    clearInterval(this.reconcileTimer);
  }

  /** Handler cho Redis Stream "zalo:outbox". */
  async handleOutboxRequest(payload) {
    await this.sendReply(payload.reply_msg_id);
  }

  async sendStalePendingReplies() {
    try {
      const replyMsgIds = await this.outboxRepository.findReplyIdsWithStalePending(config.sending.reconcileIntervalMs);
      for (const replyMsgId of replyMsgIds) {
        await this.sendReply(replyMsgId);
      }
    } catch (error) {
      logger.warn({ err: error.message }, 'Đối soát outbox lỗi');
    }
  }

  async sendReply(replyMsgId) {
    if (!replyMsgId || this.repliesInProgress.has(replyMsgId)) {
      return;
    }
    const { api } = this.getZaloSession();
    if (!api) {
      return; // chưa đăng nhập, bộ đối soát sẽ gửi sau
    }

    this.repliesInProgress.add(replyMsgId);
    try {
      const pendingParts = await this.outboxRepository.findPendingByReply(replyMsgId);
      for (const part of pendingParts) {
        const isSent = await this.sendPart(api, part);
        if (!isSent) {
          return; // giữ thứ tự: phần sau chờ phần trước gửi được
        }
      }
      const remainingParts = await this.outboxRepository.countPendingByReply(replyMsgId);
      if (remainingParts === 0) {
        await this.replyJobRepository.markSentIfSending(replyMsgId);
        logger.info({ replyMsgId, parts: pendingParts.length }, 'Đã gửi câu trả lời lên Zalo');
      }
    } finally {
      this.repliesInProgress.delete(replyMsgId);
    }
  }

  async waitForSendingSlot() {
    const { delayMinMs, delayMaxMs, minIntervalBetweenSendsMs } = config.sending;
    const humanLikeDelay = randomBetween(delayMinMs, delayMaxMs);
    const waitForRateLimit = this.lastSentAt + minIntervalBetweenSendsMs - Date.now();
    await sleep(Math.max(humanLikeDelay, waitForRateLimit));
  }

  /** @returns {Promise<boolean>} true nếu gửi thành công */
  async sendPart(api, part) {
    const zaloThreadType = toZaloThreadType(part.thread_type);
    try {
      api.sendTypingEvent(part.thread_id, zaloThreadType).catch(() => {});
      await this.waitForSendingSlot();

      const messageContent = { msg: part.text };
      if (part.quote_msg_id) {
        const originalMessage = await this.messageRepository.findById(part.quote_msg_id);
        messageContent.quote = buildQuoteFromRawMessage(originalMessage?.raw);
      }
      if (part.mention_uid && part.mention_length > 0) {
        messageContent.mentions = [{ pos: 0, uid: part.mention_uid, len: part.mention_length }];
      }

      const response = await api.sendMessage(messageContent, part.thread_id, zaloThreadType);
      this.lastSentAt = Date.now();
      const zaloMsgId = response?.message?.msgId != null ? String(response.message.msgId) : null;
      await this.outboxRepository.markSent(part.id, zaloMsgId);
      this.stats.sentMessages += 1;
      return true;
    } catch (error) {
      const newStatus = await this.outboxRepository.recordFailure(part.id, error.message, config.sending.maxAttempts);
      logger.warn({ outboxId: part.id, err: error.message, newStatus }, 'Gửi tin lên Zalo lỗi');
      if (newStatus === OUTBOX_STATUS.failed) {
        this.stats.failedMessages += 1;
        await this.replyJobRepository.markFailed(part.reply_msg_id, `Gửi Zalo lỗi: ${error.message}`);
        await sendAlert('Không gửi được câu trả lời lên Zalo', `reply_msg_id=${part.reply_msg_id}: ${error.message}`);
      }
      return false;
    }
  }
}
