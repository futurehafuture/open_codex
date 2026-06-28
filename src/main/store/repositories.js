'use strict';

const path = require('path');
const { getDb, close } = require('./db');

/** Generate a short, sortable-ish id. */
function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* Projects --------------------------------------------------------------- */

/** Insert-or-get a project keyed by its workspace path. */
function ensureProject(dir, name) {
  const db = getDb();
  if (!db) return null;
  const existing = db.prepare('SELECT * FROM projects WHERE path = ?').get(dir);
  if (existing) return existing;
  const row = { id: newId('p_'), name: name || path.basename(dir) || dir, path: dir, created_at: Date.now() };
  db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)')
    .run(row.id, row.name, row.path, row.created_at);
  return row;
}

function listProjects() {
  const db = getDb();
  if (!db) return [];
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

/* Threads ---------------------------------------------------------------- */

function createThread(projectId) {
  const db = getDb();
  if (!db) return null;
  const now = Date.now();
  const row = { id: newId('t_'), project_id: projectId, engine_thread_id: null, title: null, created_at: now, updated_at: now };
  db.prepare('INSERT INTO threads (id, project_id, engine_thread_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, row.project_id, row.engine_thread_id, row.title, row.created_at, row.updated_at);
  return row;
}

function getThreadByEngineId(engineThreadId) {
  const db = getDb();
  if (!db || !engineThreadId) return null;
  return db.prepare('SELECT * FROM threads WHERE engine_thread_id = ?').get(engineThreadId);
}

function setThreadEngineId(threadId, engineThreadId) {
  const db = getDb();
  if (!db) return;
  db.prepare('UPDATE threads SET engine_thread_id = ? WHERE id = ?').run(engineThreadId, threadId);
}

function setThreadTitle(threadId, title) {
  const db = getDb();
  if (!db) return;
  db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, threadId);
}

function touchThread(threadId) {
  const db = getDb();
  if (!db) return;
  db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), threadId);
}

function listThreads(projectId) {
  const db = getDb();
  if (!db) return [];
  return db.prepare('SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
}

/* Messages --------------------------------------------------------------- */

function appendUserMessage(threadId, text) {
  const db = getDb();
  if (!db) return;
  db.prepare('INSERT INTO messages (thread_id, item_id, role, item_type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(threadId, null, 'user', 'user_message', JSON.stringify({ text }), Date.now());
}

/** Persist a completed agent item (one terminal state per item -> no dedup needed). */
function appendItem(threadId, item) {
  const db = getDb();
  if (!db) return;
  db.prepare('INSERT INTO messages (thread_id, item_id, role, item_type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(threadId, item.id || null, 'agent', item.type || 'unknown', JSON.stringify(item), Date.now());
}

function listMessages(threadId) {
  const db = getDb();
  if (!db) return [];
  return db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);
}

/** Delete a thread and all of its messages (no FK cascade, so do it manually). */
function deleteThread(threadId) {
  const db = getDb();
  if (!db || !threadId) return false;
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM messages WHERE thread_id = ?').run(id);
    db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  });
  tx(threadId);
  return true;
}

module.exports = {
  ensureProject,
  listProjects,
  createThread,
  getThreadByEngineId,
  setThreadEngineId,
  setThreadTitle,
  touchThread,
  listThreads,
  appendUserMessage,
  appendItem,
  listMessages,
  deleteThread,
  close,
};
