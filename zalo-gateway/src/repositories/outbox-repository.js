import { OUTBOX_STATUS } from '../contracts.js';

export class OutboxRepository {
  constructor(pool) {
    this.pool = pool;
  }

  /** Các phần chưa gửi của 1 câu trả lời, theo đúng thứ tự. */
  async findPendingByReply(replyMsgId) {
    const result = await this.pool.query(
      `SELECT * FROM outbox_messages
       WHERE reply_msg_id = $1 AND status = $2
       ORDER BY kind, chunk_index`,
      [replyMsgId, OUTBOX_STATUS.pending],
    );
    return result.rows;
  }

  async countPendingByReply(replyMsgId) {
    const result = await this.pool.query(
      'SELECT count(*)::int AS pending FROM outbox_messages WHERE reply_msg_id = $1 AND status = $2',
      [replyMsgId, OUTBOX_STATUS.pending],
    );
    return result.rows[0].pending;
  }

  async markSent(outboxId, zaloMsgId) {
    await this.pool.query(
      `UPDATE outbox_messages SET status = $2, zalo_msg_id = $3, error = NULL, sent_at = now() WHERE id = $1`,
      [outboxId, OUTBOX_STATUS.sent, zaloMsgId],
    );
  }

  /** Ghi nhận 1 lần gửi lỗi. Quá số lần cho phép thì chuyển failed. Trả về trạng thái mới. */
  async recordFailure(outboxId, errorMessage, maxAttempts) {
    const result = await this.pool.query(
      `UPDATE outbox_messages
       SET attempts = attempts + 1,
           error = $2,
           status = CASE WHEN attempts + 1 >= $3 THEN $4 ELSE status END
       WHERE id = $1
       RETURNING status`,
      [outboxId, errorMessage, maxAttempts, OUTBOX_STATUS.failed],
    );
    return result.rows[0]?.status;
  }

  /** Câu trả lời còn phần chưa gửi đã lâu (để đưa lại vào hàng gửi). */
  async findReplyIdsWithStalePending(olderThanMs) {
    const result = await this.pool.query(
      `SELECT DISTINCT reply_msg_id FROM outbox_messages
       WHERE status = $1 AND created_at < now() - ($2::int * interval '1 millisecond')
       LIMIT 200`,
      [OUTBOX_STATUS.pending, olderThanMs],
    );
    return result.rows.map((row) => row.reply_msg_id);
  }
}
