'use strict';

/**
 * Minimal leveled logger for the main process. Avoids bare console.log debug
 * noise and gives every module a named channel.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[process.env.OPEN_CODEX_LOG_LEVEL] || LEVELS.info;

function emit(level, scope, args) {
  if (LEVELS[level] < THRESHOLD) return;
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()} (${scope})`;
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(prefix, ...args);
}

/**
 * @param {string} scope module name shown in every line
 */
function createLogger(scope) {
  return {
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
  };
}

module.exports = { createLogger };
