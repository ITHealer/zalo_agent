import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { svc: 'zalo-agent' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['cookie', '*.cookie', 'imei', '*.imei', 'apiKey', '*.apiKey'], censor: '[redacted]' },
});
