import { config } from '../config.js';
import { logger } from '../logger.js';
import { STREAMS } from '../contracts.js';
import { normalizeZaloMessage } from '../zalo/message-normalizer.js';

/**
 * Lưu mọi tin nhận được (idempotent theo msg_id) và tạo yêu cầu trả lời khi bot được gọi.
 *
 * Thứ tự an toàn: ghi DB trước -> báo agent-service qua Redis Stream sau.
 * Nếu process chết giữa 2 bước, bộ đối soát bên agent-service sẽ thấy job "queued" và xử lý tiếp.
 */
export class MessageIngestor {
  /**
   * @param {object} dependencies
   * @param {import('../repositories/message-repository.js').MessageRepository} dependencies.messageRepository
   * @param {import('../repositories/thread-repository.js').ThreadRepository} dependencies.threadRepository
   * @param {import('../repositories/reply-job-repository.js').ReplyJobRepository} dependencies.replyJobRepository
   * @param {import('../infrastructure/redis-streams.js').StreamPublisher} dependencies.streamPublisher
   * @param {(message: object) => void} [dependencies.onReplyQueued]  vd: gửi trạng thái "đang soạn tin"
   */
  constructor({ messageRepository, threadRepository, replyJobRepository, streamPublisher, onReplyQueued }) {
    this.messageRepository = messageRepository;
    this.threadRepository = threadRepository;
    this.replyJobRepository = replyJobRepository;
    this.streamPublisher = streamPublisher;
    this.onReplyQueued = onReplyQueued || (() => {});
    this.stats = { live: 0, ws_backfill: 0, http_sweep: 0, duplicates: 0, replyRequests: 0 };
  }

  shouldStore(message) {
    if (message.threadType === 'user') {
      return config.storage.storeDirectMessages;
    }
    const allowlist = config.storage.groupAllowlist;
    return allowlist.length === 0 || allowlist.includes(message.threadId);
  }

  canReplyIn(message) {
    if (message.threadType === 'user') {
      return config.trigger.replyToDirectMessages;
    }
    const allowlist = config.trigger.replyGroupAllowlist;
    return allowlist.length === 0 || allowlist.includes(message.threadId);
  }

  /**
   * @returns {Promise<{isNew: boolean, triggersBot: boolean}>}
   */
  async ingest(zaloMessage, botUid, source) {
    const message = normalizeZaloMessage(zaloMessage, botUid, source, {
      replyOnQuoteToBot: config.trigger.replyOnQuoteToBot,
      replyOnMentionAll: config.trigger.replyOnMentionAll,
      keywords: config.trigger.keywords,
    });

    const hasValidIdentity = message.msgId && Number.isFinite(message.timestamp);
    if (!hasValidIdentity || !this.shouldStore(message)) {
      return { isNew: false, triggersBot: false };
    }

    // Nhắn riêng cho bot (khi bật trả lời DM) luôn được coi là gọi bot
    const isDirectMessageToBot = message.threadType === 'user' && !message.isSelf;
    if (isDirectMessageToBot && config.trigger.replyToDirectMessages) {
      message.triggersBot = true;
      message.triggerKind = message.triggerKind || 'direct';
    }

    const isNew = await this.messageRepository.insertIfAbsent(message);
    if (!isNew) {
      this.stats.duplicates += 1;
      return { isNew: false, triggersBot: message.triggersBot };
    }
    this.stats[source] = (this.stats[source] || 0) + 1;
    await this.threadRepository.updateLatestMessage(message.threadId, message.threadType, message.msgId, message.timestamp);

    if (message.triggersBot && this.canReplyIn(message)) {
      await this.createReplyRequest(message);
    }
    return { isNew: true, triggersBot: message.triggersBot };
  }

  async createReplyRequest(message) {
    const isNewJob = await this.replyJobRepository.createIfAbsent(message.msgId, message.threadId, message.threadType);
    if (!isNewJob) {
      return;
    }

    const messageAgeMs = Date.now() - message.timestamp;
    if (messageAgeMs > config.trigger.maxMessageAgeMs) {
      const ageInSeconds = Math.round(messageAgeMs / 1000);
      await this.replyJobRepository.markSkipped(message.msgId, `stale:${ageInSeconds}s`);
      logger.warn({ msgId: message.msgId, ageInSeconds }, 'Tin tag bot quá cũ, bỏ qua không trả lời');
      return;
    }

    await this.streamPublisher.publish(STREAMS.replyRequests, { msg_id: message.msgId });
    this.stats.replyRequests += 1;
    this.onReplyQueued(message);
    logger.info(
      { msgId: message.msgId, threadId: message.threadId, triggerKind: message.triggerKind, source: message.source },
      'Bot được gọi, đã gửi yêu cầu trả lời',
    );
  }
}
