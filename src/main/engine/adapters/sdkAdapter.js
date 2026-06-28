'use strict';

const { createLogger } = require('../../util/logger');

const log = createLogger('engine:sdk');

/**
 * Engine adapter backed by the official `@openai/codex-sdk`.
 *
 * The SDK spawns the bundled `codex` CLI and exchanges structured JSONL events
 * over stdio. This is the fast path (M0): it gives real, typed agent output
 * (messages, reasoning, command runs, file diffs, todo lists) without scraping
 * the terminal UI. It supports preset approval policies but NOT interactive
 * per-command approvals — use the app-server adapter for that.
 */
class SdkAdapter {
  /**
   * @param {(event: import('./types').EngineEvent) => void} onEvent
   * @param {{codexPath?: string, apiKey?: string, baseUrl?: string}} [opts]
   */
  constructor(onEvent, opts = {}) {
    this.onEvent = onEvent;
    this.opts = opts;
    this.mode = 'sdk';
    /** @type {Map<string, {thread: any, controller: AbortController|null}>} */
    this.sessions = new Map();
    this._Codex = null;
  }

  supportsInteractiveApproval() {
    return false;
  }

  async _loadSdk() {
    if (this._Codex) return this._Codex;
    // `@openai/codex-sdk` ships as ESM; load it via dynamic import from CJS.
    const mod = await import('@openai/codex-sdk');
    this._Codex = mod.Codex;
    return this._Codex;
  }

  _codex() {
    const Codex = this._Codex;
    const options = {};
    if (this.opts.codexPath) options.codexPathOverride = this.opts.codexPath;
    // baseUrl + apiKey power the "bring your own OpenAI-compatible endpoint"
    // flow: the SDK turns baseUrl into `--config openai_base_url=...` and apiKey
    // into the CODEX_API_KEY env var for the spawned `codex exec`.
    if (this.opts.baseUrl) options.baseUrl = this.opts.baseUrl;
    if (this.opts.apiKey) options.apiKey = this.opts.apiKey;
    return new Codex(options);
  }

  /**
   * @param {string} sessionId local session id
   * @param {{cwd?: string, model?: string, approvalPolicy?: string, sandboxMode?: string, resumeThreadId?: string}} cfg
   */
  async startSession(sessionId, cfg = {}) {
    await this._loadSdk();
    const codex = this._codex();
    const threadOptions = {
      workingDirectory: cfg.cwd,
      model: cfg.model,
      approvalPolicy: cfg.approvalPolicy,
      sandboxMode: cfg.sandboxMode,
      skipGitRepoCheck: true,
    };
    const thread = cfg.resumeThreadId
      ? codex.resumeThread(cfg.resumeThreadId, threadOptions)
      : codex.startThread(threadOptions);
    this.sessions.set(sessionId, { thread, controller: null });
    log.info(`session ${sessionId} started (resume=${cfg.resumeThreadId || 'no'})`);
    return { sessionId };
  }

  /**
   * Stream one turn for the given session.
   * @param {string} sessionId
   * @param {string} text
   */
  async sendPrompt(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.onEvent({ kind: 'error', sessionId, message: 'Session not started' });
      return;
    }
    const controller = new AbortController();
    session.controller = controller;
    try {
      const { events } = await session.thread.runStreamed(text, { signal: controller.signal });
      for await (const event of events) {
        this._forward(sessionId, event);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        log.info(`session ${sessionId} turn aborted`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(`session ${sessionId} turn failed: ${message}`);
      this.onEvent({ kind: 'error', sessionId, message });
    } finally {
      session.controller = null;
    }
  }

  /** Interactive approvals are unsupported by the SDK; this is a no-op. */
  respondApproval() {
    log.warn('respondApproval called on SDK adapter; ignored (use app-server mode)');
  }

  interrupt(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.controller) session.controller.abort();
  }

  dispose(sessionId) {
    this.interrupt(sessionId);
    this.sessions.delete(sessionId);
  }

  disposeAll() {
    for (const id of this.sessions.keys()) this.dispose(id);
  }

  /**
   * Translate an `@openai/codex-sdk` ThreadEvent into a NormalizedEvent.
   * @param {string} sessionId
   * @param {any} event
   */
  _forward(sessionId, event) {
    switch (event.type) {
      case 'thread.started':
        this.onEvent({ kind: 'thread_started', sessionId, threadId: event.thread_id });
        return;
      case 'turn.started':
        this.onEvent({ kind: 'turn_started', sessionId });
        return;
      case 'turn.completed':
        this.onEvent({ kind: 'turn_completed', sessionId, usage: event.usage });
        return;
      case 'turn.failed':
        this.onEvent({ kind: 'turn_failed', sessionId, message: event.error?.message });
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const phase = event.type.split('.')[1];
        this.onEvent({ kind: 'item', sessionId, phase, item: normalizeItem(event.item) });
        return;
      }
      case 'error':
        this.onEvent({ kind: 'error', sessionId, message: event.message });
        return;
      default:
        log.debug(`unhandled sdk event ${event.type}`);
    }
  }
}

/**
 * Map an SDK ThreadItem (snake_case) to the renderer-facing NormalizedItem.
 * @param {any} item
 * @returns {import('./types').NormalizedItem}
 */
function normalizeItem(item) {
  const base = { id: item.id, type: item.type, status: item.status };
  switch (item.type) {
    case 'agent_message':
    case 'reasoning':
    case 'error':
      return { ...base, text: item.text || item.message };
    case 'command_execution':
      return {
        ...base,
        command: item.command,
        aggregatedOutput: item.aggregated_output,
        exitCode: item.exit_code,
      };
    case 'file_change':
      return { ...base, changes: item.changes };
    case 'todo_list':
      return { ...base, items: item.items };
    case 'web_search':
      return { ...base, query: item.query };
    case 'mcp_tool_call':
      return { ...base, command: `${item.server}.${item.tool}` };
    default:
      return base;
  }
}

module.exports = { SdkAdapter, normalizeItem };
