import { logger } from '../logger.js';

/** Key/value lưu session Zalo + nhật ký kết nối. */
export class StateRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async get(key) {
    const result = await this.pool.query('SELECT value FROM bot_state WHERE key = $1', [key]);
    return result.rows[0]?.value ?? null;
  }

  async set(key, value) {
    await this.pool.query(
      `INSERT INTO bot_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  /** Ghi nhật ký kết nối. Không bao giờ throw (chỉ phục vụ điều tra sự cố). */
  async recordConnectionEvent(event, detail = null) {
    try {
      await this.pool.query('INSERT INTO connection_events (event, detail) VALUES ($1, $2)', [
        event,
        JSON.stringify(detail),
      ]);
    } catch (error) {
      logger.warn({ err: error.message }, 'Không ghi được connection event');
    }
  }
}
