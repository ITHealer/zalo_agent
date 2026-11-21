import { REPLY_STATUS } from '../contracts.js';

export class ReplyJobRepository {
  constructor(pool) {
    this.pool = pool;
  }

  /** Tạo job trả lời. Trả về true nếu là job mới. */
  async createIfAbsent(msgId, threadId, threadType) {
    const result = await this.pool.query(
      `INSERT INTO reply_jobs (msg_id, thread_id, thread_type, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (msg_id) DO NOTHING`,
      [msgId, threadId, threadType, REPLY_STATUS.queued],
    );
    return result.rowCount === 1;
  }

  async findById(msgId) {
    const result = await this.pool.query('SELECT * FROM reply_jobs WHERE msg_id = $1', [msgId]);
    return result.rows[0] || null;
  }

  async markSkipped(msgId, reason) {
    await this.pool.query(
      `UPDATE reply_jobs SET status = $2, skip_reason = $3, updated_at = now() WHERE msg_id = $1`,
      [msgId, REPLY_STATUS.skipped, reason],
    );
  }

  /** Gửi xong mọi phần câu trả lời -> sent (chỉ khi job đang ở trạng thái sending). */
  async markSentIfSending(msgId) {
    await this.pool.query(
      `UPDATE reply_jobs SET status = $2, error = NULL, updated_at = now() WHERE msg_id = $1 AND status = $3`,
      [msgId, REPLY_STATUS.sent, REPLY_STATUS.sending],
    );
  }

  async markFailed(msgId, errorMessage) {
    await this.pool.query(
      `UPDATE reply_jobs SET status = $2, error = $3, updated_at = now() WHERE msg_id = $1`,
      [msgId, REPLY_STATUS.failed, errorMessage],
    );
  }
}
