import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (err) => logger.error({ err }, 'postgres pool error'));

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file]);
      if (rowCount) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info({ file }, 'applied migration');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

// ---------- messages ----------

/** Lưu tin; trả về true nếu là tin mới (chưa có trong DB). */
export async function insertMessage(m) {
  const { rowCount } = await pool.query(
    `INSERT INTO zalo_messages
      (msg_id, cli_msg_id, thread_id, thread_type, sender_uid, sender_name, msg_type, text, content,
       mentions, quote, ts, is_self, triggers_bot, source, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (msg_id) DO NOTHING`,
    [
      m.msgId,
      m.cliMsgId,
      m.threadId,
      m.threadType,
      m.senderUid,
      m.senderName,
      m.msgType,
      m.text,
      JSON.stringify(m.content ?? null),
      JSON.stringify(m.mentions ?? null),
      JSON.stringify(m.quote ?? null),
      m.ts,
      m.isSelf,
      m.triggersBot,
      m.source,
      JSON.stringify(m.raw ?? null),
    ],
  );
  return rowCount === 1;
}

export async function upsertThreadCursor(threadId, threadType, msgId, ts) {
  await pool.query(
    `INSERT INTO zalo_threads (thread_id, thread_type, last_msg_id, last_ts)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (thread_id) DO UPDATE SET
       last_msg_id = CASE WHEN zalo_threads.last_ts IS NULL OR EXCLUDED.last_ts >= zalo_threads.last_ts
                          THEN EXCLUDED.last_msg_id ELSE zalo_threads.last_msg_id END,
       last_ts = GREATEST(COALESCE(zalo_threads.last_ts, 0), EXCLUDED.last_ts),
       updated_at = now()`,
    [threadId, threadType, msgId, ts],
  );
}

export async function setThreadName(threadId, threadType, name) {
  await pool.query(
    `INSERT INTO zalo_threads (thread_id, thread_type, name) VALUES ($1,$2,$3)
     ON CONFLICT (thread_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [threadId, threadType, name],
  );
}

export async function markThreadSwept(threadId) {
  await pool.query('UPDATE zalo_threads SET last_swept_at = now() WHERE thread_id = $1', [threadId]);
}

export async function getThread(threadId) {
  const { rows } = await pool.query('SELECT * FROM zalo_threads WHERE thread_id = $1', [threadId]);
  return rows[0] || null;
}

export async function getLatestMessageId(threadType) {
  const { rows } = await pool.query(
    `SELECT msg_id FROM zalo_messages WHERE thread_type = $1 AND source <> 'self_sent'
     ORDER BY ts DESC LIMIT 1`,
    [threadType],
  );
  return rows[0]?.msg_id || null;
}

export async function messageExists(msgIds) {
  if (!msgIds.length) return new Set();
  const { rows } = await pool.query('SELECT msg_id FROM zalo_messages WHERE msg_id = ANY($1)', [msgIds]);
  return new Set(rows.map((r) => r.msg_id));
}

export async function getMessage(msgId) {
  const { rows } = await pool.query('SELECT * FROM zalo_messages WHERE msg_id = $1', [msgId]);
  return rows[0] || null;
}

/** N tin gần nhất trong thread, trước (và gồm) thời điểm ts, theo thứ tự thời gian tăng dần. */
export async function getContextMessages(threadId, beforeTs, limit) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT msg_id, sender_uid, sender_name, text, msg_type, ts, is_self
       FROM zalo_messages WHERE thread_id = $1 AND ts <= $2
       ORDER BY ts DESC LIMIT $3
     ) t ORDER BY ts ASC`,
    [threadId, beforeTs, limit],
  );
  return rows;
}

// ---------- reply jobs ----------

export async function createReplyJob(msgId, threadId) {
  const { rowCount } = await pool.query(
    `INSERT INTO reply_jobs (msg_id, thread_id) VALUES ($1,$2) ON CONFLICT (msg_id) DO NOTHING`,
    [msgId, threadId],
  );
  return rowCount === 1;
}

export async function getReplyJob(msgId) {
  const { rows } = await pool.query('SELECT * FROM reply_jobs WHERE msg_id = $1', [msgId]);
  return rows[0] || null;
}

export async function updateReplyJob(msgId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) =>
    fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k],
  );
  await pool.query(`UPDATE reply_jobs SET ${sets.join(', ')}, updated_at = now() WHERE msg_id = $1`, [
    msgId,
    ...values,
  ]);
}

/** Job chưa hoàn tất (để re-enqueue khi khởi động / định kỳ). */
export async function getPendingReplyJobs(olderThanMs) {
  const { rows } = await pool.query(
    `SELECT msg_id FROM reply_jobs
     WHERE status IN ('queued','processing','answered') AND updated_at < now() - ($1::int * interval '1 millisecond')
     ORDER BY created_at ASC LIMIT 200`,
    [olderThanMs],
  );
  return rows.map((r) => r.msg_id);
}

/** Lịch sử hỏi-đáp gần nhất của bot trong thread (để agent có ngữ cảnh hội thoại). */
export async function getRecentQa(threadId, beforeMsgId, limit) {
  const { rows } = await pool.query(
    `SELECT j.question, j.answer, m.sender_name FROM reply_jobs j JOIN zalo_messages m ON m.msg_id = j.msg_id
     WHERE j.thread_id = $1 AND j.status = 'sent' AND j.msg_id <> $2 AND j.answer IS NOT NULL
     ORDER BY m.ts DESC LIMIT $3`,
    [threadId, beforeMsgId, limit],
  );
  return rows.reverse();
}

// ---------- openwebui chats ----------

export async function getOpenWebUIChat(chatKey) {
  const { rows } = await pool.query('SELECT chat_id FROM openwebui_chats WHERE chat_key = $1', [chatKey]);
  return rows[0]?.chat_id || null;
}

export async function saveOpenWebUIChat(chatKey, threadId, chatId) {
  await pool.query(
    `INSERT INTO openwebui_chats (chat_key, thread_id, chat_id) VALUES ($1,$2,$3)
     ON CONFLICT (chat_key) DO UPDATE SET chat_id = EXCLUDED.chat_id`,
    [chatKey, threadId, chatId],
  );
}

// ---------- state ----------

export async function getState(key) {
  const { rows } = await pool.query('SELECT value FROM bot_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setState(key, value) {
  await pool.query(
    `INSERT INTO bot_state (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function logConnectionEvent(event, detail = null) {
  await pool
    .query('INSERT INTO connection_events (event, detail) VALUES ($1,$2)', [event, JSON.stringify(detail)])
    .catch((err) => logger.warn({ err }, 'cannot log connection event'));
}
