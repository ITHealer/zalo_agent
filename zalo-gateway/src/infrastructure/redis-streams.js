import { logger } from '../logger.js';

/**
 * Redis Stream chỉ dùng để "báo có việc". Trạng thái thật nằm trong Postgres,
 * nên handler luôn được ACK sau khi chạy (kể cả lỗi): việc thử lại do bộ đối soát (reconciler) đảm nhiệm.
 */
export class StreamPublisher {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  async publish(streamName, payload) {
    const fields = Object.entries(payload).flat().map(String);
    // MAXLEN ~ để stream không phình vô hạn
    await this.redis.xadd(streamName, 'MAXLEN', '~', '100000', '*', ...fields);
  }
}

function fieldsToObject(fields) {
  const result = {};
  for (let index = 0; index < fields.length; index += 2) {
    result[fields[index]] = fields[index + 1];
  }
  return result;
}

export class StreamConsumer {
  /**
   * @param {object} options
   * @param {import('ioredis').Redis} options.redisClient  kết nối riêng (lệnh BLOCK chiếm kết nối)
   * @param {string} options.streamName
   * @param {string} options.groupName
   * @param {string} options.consumerName
   * @param {(payload: object) => Promise<void>} options.handleMessage
   */
  constructor({ redisClient, streamName, groupName, consumerName, handleMessage }) {
    this.redis = redisClient;
    this.streamName = streamName;
    this.groupName = groupName;
    this.consumerName = consumerName;
    this.handleMessage = handleMessage;
    this.isRunning = false;
  }

  async ensureGroupExists() {
    try {
      await this.redis.xgroup('CREATE', this.streamName, this.groupName, '0', 'MKSTREAM');
    } catch (error) {
      if (!String(error.message).includes('BUSYGROUP')) {
        throw error;
      }
    }
  }

  async start() {
    await this.ensureGroupExists();
    this.isRunning = true;
    this.loopPromise = this.runLoop();
  }

  async stop() {
    this.isRunning = false;
    await this.loopPromise;
  }

  async runLoop() {
    while (this.isRunning) {
      try {
        const response = await this.redis.xreadgroup(
          'GROUP',
          this.groupName,
          this.consumerName,
          'COUNT',
          '10',
          'BLOCK',
          '2000',
          'STREAMS',
          this.streamName,
          '>',
        );
        if (!response) {
          continue;
        }
        const [, entries] = response[0];
        for (const [entryId, fields] of entries) {
          await this.processEntry(entryId, fieldsToObject(fields));
        }
      } catch (error) {
        logger.warn({ err: error.message, stream: this.streamName }, 'Lỗi đọc Redis stream, thử lại sau 2s');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async processEntry(entryId, payload) {
    try {
      await this.handleMessage(payload);
    } catch (error) {
      logger.error({ err: error, stream: this.streamName, payload }, 'Xử lý message từ stream lỗi');
    } finally {
      await this.redis.xack(this.streamName, this.groupName, entryId);
    }
  }
}
