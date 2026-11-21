import { config } from '../config.js';
import { logger } from '../logger.js';
import { isMessageIdLessOrEqual } from './message-normalizer.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Lưới an toàn chống sót tin: định kỳ lấy tin mới nhất của từng nhóm qua HTTP (cloud message API)
 * và lùi trang cho tới khi gặp tin đã có trong DB. Mọi tin đi qua MessageIngestor nên không lưu trùng.
 */
export class HistorySweeper {
  /**
   * @param {object} dependencies
   * @param {() => {api: object, botUid: string}} dependencies.getZaloSession
   * @param {import('../services/message-ingestor.js').MessageIngestor} dependencies.messageIngestor
   * @param {import('../repositories/thread-repository.js').ThreadRepository} dependencies.threadRepository
   */
  constructor({ getZaloSession, messageIngestor, threadRepository }) {
    this.getZaloSession = getZaloSession;
    this.messageIngestor = messageIngestor;
    this.threadRepository = threadRepository;
    this.isSweeping = false;
    this.timer = null;
    this.stats = { sweeps: 0, recoveredMessages: 0, errors: 0, lastSweepAt: null };
  }

  start() {
    this.timer = setInterval(() => this.sweepAllGroups().catch(() => {}), config.sweep.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  async listGroupIds(api) {
    if (config.storage.groupAllowlist.length > 0) {
      return config.storage.groupAllowlist;
    }
    const response = await api.getAllGroups();
    return Object.keys(response.gridVerMap || {});
  }

  async sweepAllGroups() {
    const { api } = this.getZaloSession();
    if (!api || this.isSweeping) {
      return;
    }
    this.isSweeping = true;
    const startedAt = Date.now();
    let recoveredCount = 0;

    try {
      const groupIds = await this.listGroupIds(api);
      for (const groupId of groupIds) {
        try {
          recoveredCount += await this.sweepGroup(groupId);
          await this.threadRepository.markSwept(groupId);
        } catch (error) {
          this.stats.errors += 1;
          logger.warn({ groupId, err: error.message }, 'Quét bù nhóm lỗi');
        }
        await sleep(config.sweep.delayBetweenGroupsMs);
      }

      this.stats.sweeps += 1;
      this.stats.recoveredMessages += recoveredCount;
      this.stats.lastSweepAt = new Date().toISOString();
      logger.info({ groups: groupIds.length, recoveredCount, durationMs: Date.now() - startedAt }, 'Quét bù xong');
      if (recoveredCount > 0) {
        logger.warn({ recoveredCount }, 'Quét bù đã lưu thêm các tin WebSocket bỏ sót');
      }
    } catch (error) {
      this.stats.errors += 1;
      logger.error({ err: error.message }, 'Quét bù lỗi');
    } finally {
      this.isSweeping = false;
    }
  }

  async sweepGroup(groupId) {
    const { api, botUid } = this.getZaloSession();
    const thread = await this.threadRepository.findById(groupId);
    await this.saveGroupNameIfMissing(api, groupId, thread);

    const knownLatestMsgId = thread?.last_msg_id || null;
    // Lần đầu gặp nhóm: chỉ lấy 1 trang gần nhất, không kéo toàn bộ lịch sử
    const maxPages = knownLatestMsgId ? config.sweep.maxPagesPerGroup : 1;

    let recoveredCount = 0;
    let page = await api.getCloudMessage(groupId);

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const messages = page.groupMsgs || [];
      for (const message of messages) {
        const result = await this.messageIngestor.ingest(message, botUid, 'http_sweep');
        if (result.isNew) {
          recoveredCount += 1;
        }
      }

      const canLoadOlderPage = knownLatestMsgId && messages.length > 0 && page.hasMore;
      if (!canLoadOlderPage) {
        break;
      }
      const oldestMsgIdInPage = this.findOldestMessageId(messages);
      if (isMessageIdLessOrEqual(oldestMsgIdInPage, knownLatestMsgId)) {
        break; // đã lùi tới vùng tin đã lưu
      }
      if (pageNumber === maxPages) {
        logger.warn({ groupId }, 'Quét bù chạm giới hạn trang, có thể còn tin cũ hơn chưa bù');
        break;
      }
      await sleep(500);
      page = await api.getCloudMessage(groupId, page.lastMsgId, { isOld: page.isOld });
    }
    return recoveredCount;
  }

  findOldestMessageId(messages) {
    let oldestMsgId = messages[0].data.msgId;
    for (const message of messages) {
      if (isMessageIdLessOrEqual(message.data.msgId, oldestMsgId)) {
        oldestMsgId = message.data.msgId;
      }
    }
    return oldestMsgId;
  }

  async saveGroupNameIfMissing(api, groupId, thread) {
    if (thread?.name) {
      return;
    }
    try {
      const groupInfo = await api.getGroupInfo(groupId);
      const groupName = groupInfo?.gridInfoMap?.[groupId]?.name;
      if (groupName) {
        await this.threadRepository.updateName(groupId, 'group', groupName);
      }
    } catch {
      // tên nhóm không bắt buộc
    }
  }
}
