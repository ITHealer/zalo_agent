import http from 'node:http';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * GET /health cho Docker healthcheck. Thông tin chi tiết + QR xem qua API của agent-service.
 * @param {() => object} collectStatus
 */
export function startHealthServer(collectStatus) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404);
      response.end();
      return;
    }
    const status = collectStatus();
    const zaloState = status.zalo?.state;
    const isHealthy = zaloState === 'connected' || zaloState === 'connecting' || zaloState === 'idle';
    response.writeHead(isHealthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status, null, 2));
  });
  server.listen(config.httpPort, () => logger.info({ port: config.httpPort }, 'Health server đã chạy'));
  return server;
}
