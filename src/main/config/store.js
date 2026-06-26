'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { createLogger } = require('../util/logger');

const log = createLogger('config');

const FILE_NAME = 'open-codex-settings.json';
/** Marks a value that was encrypted with Electron safeStorage (base64 payload). */
const ENC_PREFIX = 'enc:v1:';

/**
 * Default settings. The SDK engine runs `codex exec` non-interactively, so it
 * cannot service interactive approvals — `approvalPolicy: 'never'` lets the
 * agent actually run commands / edit files inside the sandbox (otherwise M0
 * collapses to a plain chat reply). `engineMode` stays internal for now; the
 * app-server path is wired but unvalidated (M2).
 */
const DEFAULTS = Object.freeze({
  baseUrl: '',
  apiKey: '',
  model: '',
  approvalPolicy: 'never',
  sandboxMode: 'workspace-write',
  engineMode: 'sdk',
});

const ALLOWED_KEYS = Object.keys(DEFAULTS);

function settingsPath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`could not read settings: ${err.message}`);
    return {};
  }
}

function decryptApiKey(stored) {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored; // plaintext fallback
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch (err) {
    log.error(`failed to decrypt api key: ${err.message}`);
    return '';
  }
}

function encryptApiKey(plain) {
  if (!plain) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('safeStorage unavailable; storing API key in plaintext');
    return plain;
  }
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
}

/**
 * Keep only known keys from a patch and validate their shapes.
 * Absent keys are left untouched by the caller's merge; an empty `apiKey`
 * string explicitly clears the stored key.
 * @param {Record<string, unknown>} patch
 */
function sanitize(patch) {
  const out = {};
  for (const key of ALLOWED_KEYS) {
    if (patch[key] === undefined) continue;
    out[key] = patch[key];
  }
  if (typeof out.baseUrl === 'string') {
    out.baseUrl = out.baseUrl.trim();
    if (out.baseUrl && !/^https?:\/\//i.test(out.baseUrl)) {
      throw new Error('Base URL 需以 http:// 或 https:// 开头');
    }
  }
  if (typeof out.apiKey === 'string') out.apiKey = out.apiKey.trim();
  if (typeof out.model === 'string') out.model = out.model.trim();
  return out;
}

/**
 * Full settings including the decrypted API key. Main-process only.
 * @returns {{baseUrl:string, apiKey:string, model:string, approvalPolicy:string, sandboxMode:string, engineMode:string}}
 */
function loadSettings() {
  const raw = readRaw();
  return { ...DEFAULTS, ...raw, apiKey: decryptApiKey(raw.apiKey) };
}

/**
 * Merge a patch into the stored settings and persist (API key encrypted).
 * @param {Record<string, unknown>} patch
 * @returns {ReturnType<typeof loadSettings>} the merged settings (decrypted)
 */
function saveSettings(patch = {}) {
  const next = { ...loadSettings(), ...sanitize(patch) };
  const onDisk = { ...next, apiKey: encryptApiKey(next.apiKey) };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  log.info('settings saved');
  return next;
}

/**
 * Renderer-safe view: never exposes the raw API key, only whether one is set.
 */
function publicSettings() {
  const s = loadSettings();
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    approvalPolicy: s.approvalPolicy,
    sandboxMode: s.sandboxMode,
    engineMode: s.engineMode,
    hasApiKey: Boolean(s.apiKey),
  };
}

module.exports = { loadSettings, saveSettings, publicSettings };
