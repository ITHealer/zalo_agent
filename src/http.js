import http from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';
import { qrState } from './zalo/session.js';
import { ingestStats } from './ingest.js';
import { replyQueue } from './queue.js';
import { pool } from './db.js';

/**
 * GET /health  -> trạng thái kết nối, số liệu (dùng cho Docker healthcheck / monitor)
 * GET /qr      -> ảnh QR khi bot cần đăng nhập lại
 * Không public cổng này ra Internet (QR = quyền đăng nhập tài khoản bot).
 */
export function startHttp(getConnection) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        const conn = getConnection?.();
        const counts = await replyQueue.getJobCounts('waiting', 'active', 'delayed', 'failed').catch(() => null);
        const { rows } = await pool
          .query(`SELECT status, count(*)::int n FROM reply_jobs GROUP BY status`)
          .catch(() => ({ rows: [] }));
        const body = {
          role: config.role,
          zalo: conn ? conn.status() : null,
          qr: qrState.status,
          ingest: ingestStats,
          queue: counts,
          replyJobs: Object.fromEntries(rows.map((r) => [r.status, r.n])),
        };
        const healthy = !conn || ['connected', 'connecting'].includes(conn.state);
        res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(body, null, 2));
      }
      if (req.url === '/qr') {
        if (!qrState.image) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(`<p>Không có QR (trạng thái: ${qrState.status}).</p>`);
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          `<html><head><meta http-equiv="refresh" content="15"></head><body style="font-family:sans-serif;text-align:center">
           <h3>Quét bằng app Zalo của SỐ BOT</h3><img src="data:image/png;base64,${qrState.image.replace(/^data:image\/png;base64,/, '')}" width="300"/>
           <p>Tạo lúc ${qrState.generatedAt} - trạng thái: ${qrState.status}</p></body></html>`,
        );
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      logger.error({ err }, 'http error');
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(config.httpPort, () => logger.info({ port: config.httpPort }, 'HTTP health server'));
  return server;
}
