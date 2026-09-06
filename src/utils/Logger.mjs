import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

/**
 * Standard Logging Class Interface wrapping Pino.
 */
class Logger {
  /**
   * @param {string} moduleName - The name of the module or context (e.g., 'PaymentManager')
   */
  constructor(moduleName = 'App') {
    this.logger = pino({
      name: moduleName,
      level: process.env.LOG_LEVEL || 'info',
      transport: {
          targets: [
              {
                  target: 'pino-pretty',
                  options: {
                      colorize: true,
                      translateTime: 'SYS:standard',
                      ignore: 'pid,hostname'
                  }
              },
              {
                  target: 'pino/file',
                  options: {
                      destination: './logs/app.log',
                      mkdir: true
                  }
              }
          ]
      }
    });
  }

  /**
   * Log informational messages.
   * @param {object|string} meta - Metadata object, or the message string if no metadata is provided.
   * @param {string} [msg] - The log message (if the first argument was metadata).
   */
  info(meta, msg) {
    this.logger.info(meta, msg);
  }

  /**
   * Log warning messages.
   * @param {object|string} meta - Metadata object, or the message string if no metadata is provided.
   * @param {string} [msg] - The log message (if the first argument was metadata).
   */
  warn(meta, msg) {
    this.logger.warn(meta, msg);
  }

  /**
   * Log error messages.
   * @param {Error|object|string} meta - Error object, metadata, or the message string.
   * @param {string} [msg] - The log message (if the first argument was metadata).
   */
  error(meta, msg) {
    this.logger.error(meta, msg);
  }

  /**
   * Log debug messages.
   * @param {object|string} meta - Metadata object, or the message string if no metadata is provided.
   * @param {string} [msg] - The log message (if the first argument was metadata).
   */
  debug(meta, msg) {
    this.logger.debug(meta, msg);
  }

  /**
   * Log fatal messages (system-breaking errors).
   * @param {Error|object|string} meta - Error object, metadata, or the message string.
   * @param {string} [msg] - The log message (if the first argument was metadata).
   */
  fatal(meta, msg) {
    this.logger.fatal(meta, msg);
  }

  /**
   * Creates a child logger with additional default metadata.
   * @param {object} defaultMeta 
   * @returns {pino.Logger}
   */
  child(defaultMeta) {
    return this.logger.child(defaultMeta);
  }
}

// Export a default instance for quick use
export const logger = new Logger();
