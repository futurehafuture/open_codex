'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { SdkAdapter } = require('./adapters/sdkAdapter');
const { AppServerAdapter } = require('./adapters/appServerAdapter');
const { AgentmateAdapter } = require('./adapters/agentmateAdapter');
const { EngineMode } = require('./types');
const { createLogger } = require('../util/logger');

const log = createLogger('engine');

/** adapter registry — keyed by EngineMode. */
const ADAPTERS = {
  [EngineMode.AGENTMATE]: AgentmateAdapter,
  [EngineMode.SDK]: SdkAdapter,
  [EngineMode.APP_SERVER]: AppServerAdapter,
};

/**
 * Resolve the Codex CLI binary, preferring the bundled copy so the app is
 * self-contained.
 * @param {string} appPath result of electron app.getAppPath()
 * @returns {string}
 */
function resolveCodexCommand(appPath) {
  if (process.env.OPEN_CODEX_CLI) return process.env.OPEN_CODEX_CLI;
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const bundled = path.join(appPath, 'node_modules', '.bin', `codex${suffix}`);
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

/**
 * Probe the CLI so the UI can warn the user before any session starts.
 * @param {string} codexPath
 * @returns {Promise<{available: boolean, command: string, version?: string, error?: string}>}
 */
function checkAgent(codexPath) {
  return new Promise((resolve) => {
    const child = spawn(codexPath, ['--version'], { shell: process.platform === 'win32' });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { out += c.toString(); });
    child.on('error', (e) => resolve({ available: false, command: codexPath, error: e.message }));
    child.on('close', (code) => resolve({ available: code === 0, command: codexPath, version: out.trim() }));
  });
}

/**
 * Factory: build the engine adapter for the requested mode.
 * @param {string} mode EngineMode
 * @param {(event: import('./types').EngineEvent) => void} onEvent
 * @param {{codexPath: string, apiKey?: string}} opts
 */
function createEngine(mode, onEvent, opts) {
  const Adapter = ADAPTERS[mode];
  if (!Adapter) {
    log.warn(`unknown engine mode "${mode}", falling back to agentmate`);
    return new AgentmateAdapter(onEvent, opts);
  }
  log.info(`creating engine: ${mode}`);
  return new Adapter(onEvent, opts);
}

module.exports = { createEngine, resolveCodexCommand, checkAgent, EngineMode };
