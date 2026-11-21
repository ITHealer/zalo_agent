function toJson(value) {
  return JSON.stringify(value ?? null);
}

export class MessageRepository {
  constructor(pool) {
    this.pool = pool;
  }

  /** Lưu tin. Trả về true nếu là tin mới, false nếu đã có (trùng msg_id). */
  async insertIfAbsent(message) {
    const result = await this.pool.query(
      `INSERT INTO zalo_messages
         (msg_id, cli_msg_id, thread_id, thread_type, sender_uid, sender_name, msg_type, text, content,
          mentions, quote, ts, is_self, triggers_bot, trigger_kind, source, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (msg_id) DO NOTHING`,
      [
        message.msgId,
        message.cliMsgId,
        message.threadId,
        message.threadType,
        message.senderUid,
        message.senderName,
        message.msgType,
        message.text,
        toJson(message.content),
        toJson(message.mentions),
        toJson(message.quote),
        message.timestamp,
        message.isSelf,
        message.triggersBot,
        message.triggerKind,
        message.source,
        toJson(message.raw),
      ],
    );
    return result.rowCount === 1;
  }

  async findById(msgId) {
    const result = await this.pool.query('SELECT * FROM zalo_messages WHERE msg_id = $1', [msgId]);
    return result.rows[0] || null;
  }

  /** msg_id mới nhất nhận từ Zalo (không tính tin bot tự ghi), dùng làm mốc xin lại tin cũ. */
  async findLatestReceivedMessageId(threadType) {
    const result = await this.pool.query(
      `SELECT msg_id FROM zalo_messages
       WHERE thread_type = $1 AND source <> 'self_sent'
       ORDER BY ts DESC
       LIMIT 1`,
      [threadType],
    );
    return result.rows[0]?.msg_id || null;
  }
}
