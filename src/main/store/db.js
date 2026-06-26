'use strict';

const path = require('path');
const { app } = require('electron');
const { createLogger } = require('../util/logger');

const log = createLogger('store:db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  engine_thread_id  TEXT,
  title             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL,
  item_id     TEXT,
  role        TEXT NOT NULL,
  item_type   TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
`;

// better-sqlite3 is a native module; it only loads after `npm run rebuild`
// aligns it to Electron's ABI. If it isn't built yet we degrade to no-op
// persistence so the rest of the app (live chat) still works.
let Database = null;
try {
  Database = require('better-sqlite3');
} catch (err) {
  log.warn(`better-sqlite3 unavailable (run "npm run rebuild"); persistence disabled: ${err.message}`);
}

let db = null;

/** @returns {import('better-sqlite3').Database | null} */
function getDb() {
  if (db) return db;
  if (!Database) return null;
  try {
    const file = path.join(app.getPath('userData'), 'open-codex.db');
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    log.info(`store ready at ${file}`);
    return db;
  } catch (err) {
    log.error(`failed to open db: ${err.message}`);
    Database = null; // don't retry on every call
    return null;
  }
}

function close() {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    log.debug(`db close: ${err.message}`);
  }
  db = null;
}

module.exports = { getDb, close };
