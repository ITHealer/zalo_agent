export class ThreadRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findById(threadId) {
    const result = await this.pool.query('SELECT * FROM zalo_threads WHERE thread_id = $1', [threadId]);
    return result.rows[0] || null;
  }

  /** Cập nhật con trỏ "tin mới nhất đã lưu" nếu tin này mới hơn. */
  async updateLatestMessage(threadId, threadType, msgId, timestamp) {
    await this.pool.query(
      `INSERT INTO zalo_threads (thread_id, thread_type, last_msg_id, last_ts)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (thread_id) DO UPDATE SET
         last_msg_id = CASE
           WHEN zalo_threads.last_ts IS NULL OR EXCLUDED.last_ts >= zalo_threads.last_ts THEN EXCLUDED.last_msg_id
           ELSE zalo_threads.last_msg_id
         END,
         last_ts = GREATEST(COALESCE(zalo_threads.last_ts, 0), EXCLUDED.last_ts),
         updated_at = now()`,
      [threadId, threadType, msgId, timestamp],
    );
  }

  async updateName(threadId, threadType, name) {
    await this.pool.query(
      `INSERT INTO zalo_threads (thread_id, thread_type, name) VALUES ($1, $2, $3)
       ON CONFLICT (thread_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
      [threadId, threadType, name],
    );
  }

  async markSwept(threadId) {
    await this.pool.query('UPDATE zalo_threads SET last_swept_at = now() WHERE thread_id = $1', [threadId]);
  }
}
