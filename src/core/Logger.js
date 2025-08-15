// hydrodb/src/core/Logger.js

/**
 * Defines the available logging levels.
 * NONE: No logs will be shown.
 * ERROR: Only critical errors will be shown.
 * WARN: Warnings and errors will be shown.
 * INFO: Informational messages, warnings, and errors.
 * DEBUG: The most verbose level, showing all logs for deep debugging.
 */
export const LogLevel = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

/**
 * @class Logger
 * @description A level-based logger to provide configurable, formatted logging for HydroDB.
 */
export class Logger {
  /**
   * The current logging level.
   * @private
   * @type {number}
   */
  #level;

  /**
   * @constructor
   * @param {number} [level=LogLevel.NONE] - The initial logging level.
   */
  constructor(level = LogLevel.NONE) {
    this.#level = level;
  }

  /**
   * Changes the logging level at runtime.
   * @param {number} level - The new logging level to set.
   */
  setLevel(level) {
    this.#level = level;
  }

  /**
   * Logs a message at the DEBUG level.
   * @param {string} source - The source of the log (e.g., 'Adapter', 'Query').
   * @param {string} message - The message to log.
   * @param {...any} args - Additional data to log.
   */
  debug(source, message, ...args) {
    if (this.#level >= LogLevel.DEBUG) {
      console.debug(`[HydroDB::${source}] ${message}`, ...args);
    }
  }

  /**
   * Logs a message at the INFO level.
   * @param {string} source - The source of the log (e.g., 'Adapter', 'Query').
   * @param {string} message - The message to log.
   * @param {...any} args - Additional data to log.
   */
  info(source, message, ...args) {
    if (this.#level >= LogLevel.INFO) {
      console.info(`[HydroDB::${source}] %c${message}`, 'color: #22c55e', ...args);
    }
  }

  /**
   * Logs a message at the WARN level.
   * @param {string} source - The source of the log (e.g., 'Adapter', 'Query').
   * @param {string} message - The message to log.
   * @param {...any} args - Additional data to log.
   */
  warn(source, message, ...args) {
    if (this.#level >= LogLevel.WARN) {
      console.warn(`[HydroDB::${source}] ${message}`, ...args);
    }
  }

  /**
   * Logs a message at the ERROR level.
   * @param {string} source - The source of the log (e.g., 'Adapter', 'Query').
   * @param {string} message - The message to log.
   * @param {...any} args - Additional data to log.
   */
  error(source, message, ...args) {
    if (this.#level >= LogLevel.ERROR) {
      console.error(`[HydroDB::${source}] ${message}`, ...args);
    }
  }
}
