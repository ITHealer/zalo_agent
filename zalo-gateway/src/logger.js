import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'zalo-gateway' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['cookie', '*.cookie', 'imei', '*.imei'], censor: '[redacted]' },
});
