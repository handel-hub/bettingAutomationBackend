import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { getContext } from './context.mjs';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

const logsDir = fileURLToPath(new URL('../../logs', import.meta.url));
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const logFilePath = path.join(logsDir, 'app.log');

const fileDestination = pino.destination({
  dest: logFilePath,
  mkdir: true,
  sync: true
});

const streams = [
  { stream: process.stdout },
  { stream: fileDestination }
];

/**
 * Configure Pino Root Logger
 * Note: Redaction is disabled per explicit user request for development visibility.
 */
export const rootLogger = pino(
  {
    level: logLevel,
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: {
      service: 'betting-control-plane',
      env: process.env.NODE_ENV || 'development'
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const ctx = getContext();
      if (!ctx) return {};
      return {
        traceId: ctx.traceId,
        ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
        ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {})
      };
    }
  },
  pino.multistream(streams)
);

/**
 * Creates a scoped child logger for a specific component
 * @param {string} component 
 */
export function createScopedLogger(component) {
  return rootLogger.child({ component });
}

export const logger = createScopedLogger('App');
export default logger;
