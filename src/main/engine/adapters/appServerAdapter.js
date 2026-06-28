'use strict';

const { spawn } = require('child_process');
const { JsonRpcChannel } = require('../jsonRpc');
const { createLogger } = require('../../util/logger');

const log = createLogger('engine:app-server');

const CLIENT_INFO = { name: 'open_codex_app', title: 'Open Codex App', version: '0.2.0' };

/**
 * Engine adapter backed by `codex app-server` (JSON-RPC 2.0 over stdio) — the
 * same interface OpenAI's VS Code extension uses.
 *
 * This is the full control plane: thread start/resume/fork, multi-session, and
 * crucially INTERACTIVE approvals. When the agent wants to run a command or
 * edit a file under a gated policy, the server sends a `requestApproval`
 * request; we forward it to the renderer and reply with the user's decision.
 */
class AppServerAdapter {
  /**
   * @param {(event: import('./types').EngineEvent) => void} onEvent
   * @param {{codexPath: string, apiKey?: string, baseUrl?: string}} opts
   */
  constructor(onEvent, opts) {
    this.onEvent = onEvent;
    this.opts = opts;
    this.mode = 'app-server';
    this.child = null;
    this.rpc = null;
    this.initialized = false;
    /** local sessionId -> engine threadId */
    this.sessionToThread = new Map();
    /** engine threadId -> local sessionId */
    this.threadToSession = new Map();
    /** pending server requestId -> threadId (for approval routing) */
    this.pendingApprovals = new Map();
    /** `${threadId}:${itemId}` -> accumulated agent text for delta notifications */
    this.itemTextBuffers = new Map();
  }

  supportsInteractiveApproval() {
    return true;
  }

  async _ensureProcess() {
    if (this.rpc) return;
    const env = { ...process.env };
    // CODEX_API_KEY is the variable the codex CLI reads (same as the SDK path).
    if (this.opts.apiKey) env.CODEX_API_KEY = this.opts.apiKey;

    // Build CLI args. `codex app-server` accepts `--config` overrides matching
    // the `codex exec` path: `--config openai_base_url=<url>`.
    const args = ['app-server'];
    if (this.opts.baseUrl) {
      args.push('--config', `openai_base_url=${this.opts.baseUrl}`);
      // Also set OPENAI_BASE_URL as a fallback env var (defense in depth).
      env.OPENAI_BASE_URL = this.opts.baseUrl;
    }

    const child = spawn(this.opts.codexPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => log.debug(`app-server stderr: ${d.trim()}`));
    child.on('exit', (code) => {
      log.warn(`app-server exited code=${code}`);
      this.rpc = null;
      this.child = null;
      this.initialized = false;
    });

    this.child = child;
    this.rpc = new JsonRpcChannel(child.stdin, child.stdout);
    this.rpc.on('notification', (method, params) => this._onNotification(method, params));
    this.rpc.on('request', (id, method, params) => this._onServerRequest(id, method, params));
    this.rpc.on('close', () => this.rpc?.rejectAll('app-server closed'));

    await this.rpc.request('initialize', { clientInfo: CLIENT_INFO });
    this.rpc.notify('initialized', {});
    this.initialized = true;
    log.info('app-server initialized');
  }

  /**
   * @param {string} sessionId
   * @param {{cwd?: string, model?: string, approvalPolicy?: string, sandboxMode?: string, resumeThreadId?: string}} cfg
   */
  async startSession(sessionId, cfg = {}) {
    await this._ensureProcess();
    const params = {
      cwd: cfg.cwd,
      model: cfg.model,
      approvalPolicy: cfg.approvalPolicy,
      sandbox: toSandbox(cfg.sandboxMode),
    };
    const method = cfg.resumeThreadId ? 'thread/resume' : 'thread/start';
    if (cfg.resumeThreadId) params.threadId = cfg.resumeThreadId;
    const result = await this.rpc.request(method, prune(params));
    const threadId = result?.thread?.id || cfg.resumeThreadId;
    this.sessionToThread.set(sessionId, threadId);
    this.threadToSession.set(threadId, sessionId);
    this.onEvent({ kind: 'thread_started', sessionId, threadId });
    log.info(`session ${sessionId} -> thread ${threadId}`);
    return { sessionId, threadId };
  }

  async sendPrompt(sessionId, text) {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) {
      this.onEvent({ kind: 'error', sessionId, message: 'Session not started' });
      return;
    }
    this.onEvent({ kind: 'turn_started', sessionId });
    try {
      await this.rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
      });
    } catch (err) {
      this.onEvent({ kind: 'error', sessionId, message: err.message });
    }
  }

  /**
   * Reply to a pending approval request.
   * @param {number} requestId
   * @param {string|object} decision e.g. 'accept', 'acceptForSession', 'decline', 'cancel'
   */
  respondApproval(requestId, decision) {
    if (!this.rpc) {
      log.warn(`Cannot respond to approval ${requestId}: app-server not connected`);
      this.onEvent({ kind: 'error', message: '审批响应失败：引擎未连接，请检查 app-server 是否正常运行。' });
      return;
    }
    this.rpc.respond(requestId, { decision });
    this.pendingApprovals.delete(requestId);
  }

  interrupt(sessionId) {
    const threadId = this.sessionToThread.get(sessionId);
    if (threadId && this.rpc) this.rpc.notify('turn/interrupt', { threadId });
  }

  dispose(sessionId) {
    const threadId = this.sessionToThread.get(sessionId);
    if (threadId) {
      this.threadToSession.delete(threadId);
      this.sessionToThread.delete(sessionId);
    }
  }

  disposeAll() {
    if (this.child) this.child.kill();
    this.rpc = null;
    this.child = null;
    this.initialized = false;
    this.sessionToThread.clear();
    this.threadToSession.clear();
    this.pendingApprovals.clear();
    this.itemTextBuffers.clear();
  }

  _onNotification(method, params) {
    const sessionId = this.threadToSession.get(params.threadId);
    switch (method) {
      case 'turn/started':
        this.onEvent({ kind: 'turn_started', sessionId });
        return;
      case 'turn/completed':
        this.onEvent({ kind: 'turn_completed', sessionId, usage: params.usage });
        return;
      case 'turn/failed':
        this.onEvent({ kind: 'turn_failed', sessionId, message: params.error?.message });
        return;
      case 'item/started':
      case 'item/updated':
      case 'item/completed': {
        const phase = method.split('/')[1];
        const item = normalizeAppServerItem(params.item || params);
        if (item.id && item.type === 'agent_message' && item.text) {
          this.itemTextBuffers.set(`${params.threadId}:${item.id}`, item.text);
        }
        this.onEvent({ kind: 'item', sessionId, phase, item });
        if (phase === 'completed' && item.id) this.itemTextBuffers.delete(`${params.threadId}:${item.id}`);
        return;
      }
      case 'item/agentMessage/delta': {
        const key = `${params.threadId}:${params.itemId}`;
        const text = `${this.itemTextBuffers.get(key) || ''}${params.delta || ''}`;
        this.itemTextBuffers.set(key, text);
        this.onEvent({
          kind: 'item',
          sessionId,
          phase: 'updated',
          item: { id: params.itemId, type: 'agent_message', text, status: 'in_progress' },
        });
        return;
      }
      default:
        log.debug(`unhandled notification ${method}`);
    }
  }

  _onServerRequest(id, method, params) {
    const sessionId = this.threadToSession.get(params.threadId);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.pendingApprovals.set(id, params.threadId);
      const approvalType = method.includes('command') ? 'command' : 'file_change';
      this.onEvent({
        kind: 'approval_request',
        sessionId,
        threadId: params.threadId,
        approval: {
          requestId: id,
          type: approvalType,
          command: params.command,
          cwd: params.cwd,
          changes: params.changes,
          reason: params.reason,
        },
      });
      return;
    }
    // Unknown server request: decline politely so the turn is not wedged.
    log.warn(`auto-declining unsupported server request ${method}`);
    this.rpc.respondError(id, -32601, `Unsupported method: ${method}`);
  }
}

function toSandbox(mode) {
  if (!mode) return undefined;
  return { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[mode];
}

function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Normalize an app-server item (camelCase fields) into the renderer contract.
 * Field names are defensive: app-server item shapes are validated against
 * `codex app-server generate-ts` output (see scripts/gen-protocol.js).
 * @param {any} item
 */
function normalizeAppServerItem(item) {
  const type = item.type || item.itemType;
  const base = { id: item.id || item.itemId, type: snakeType(type), status: item.status };
  switch (base.type) {
    case 'command_execution':
      return { ...base, command: item.command, aggregatedOutput: item.aggregatedOutput || item.output, exitCode: item.exitCode };
    case 'file_change':
      return { ...base, changes: item.changes };
    case 'todo_list':
      return { ...base, items: item.items };
    case 'web_search':
      return { ...base, query: item.query };
    default:
      return { ...base, text: item.text || item.message };
  }
}

function snakeType(type) {
  if (!type) return 'agent_message';
  return { commandExecution: 'command_execution', fileChange: 'file_change', agentMessage: 'agent_message', todoList: 'todo_list', webSearch: 'web_search', mcpToolCall: 'mcp_tool_call' }[type] || type;
}

module.exports = { AppServerAdapter, normalizeAppServerItem };
