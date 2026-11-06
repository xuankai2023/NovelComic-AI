import { config } from '@novelcomic/config';
import pino from 'pino';
export const logger = pino({ name: 'novelcomic', level: config.LOG_LEVEL });
