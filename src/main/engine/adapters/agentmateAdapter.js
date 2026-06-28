'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { createLogger } = require('../../util/logger');

const log = createLogger('engine:agentmate');

/**
 * Engine adapter backed by the AgentMate Python agent (agent-framework).
 *
 * Spawns a Python subprocess running `bridge.py` and communicates via
 * newline-delimited JSON over stdio (JSONL). The Python process emits
 * structured events that we normalize into the EngineEvent contract.
 */
class AgentmateAdapter {
  /**
   * @param {(event: import('../types').EngineEvent) => void} onEvent
   * @param {{pythonPath?: string, workspaceDir?: string}} opts
   */
  constructor(onEvent, opts = {}) {
    this.onEvent = onEvent;
    this.opts = opts;
    this.mode = 'agentmate';
    /** sessionId -> { child, buffer } */
    this.sessions = new Map();
  }

  supportsInteractiveApproval() {
    return false;
  }

  /**
   * Spawn the Python bridge process for a session.
   * @param {string} sessionId
   * @param {{cwd?: string, model?: string, baseUrl?: string, apiKey?: string, systemPrompt?: string}} cfg
   */
  async startSession(sessionId, cfg = {}) {
    const bridgeDir = path.join(__dirname, '..', 'agentmate-python');
    const bridgeScript = path.join(bridgeDir, 'bridge.py');

    const python = this.opts.pythonPath || 'python3';
    const uvPath = this._findUv();

    let child;
    // Prefer `uv run` if available (handles venv + deps automatically).
    if (uvPath) {
      child = spawn(uvPath, ['run', 'python', bridgeScript], {
        cwd: bridgeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } else {
      child = spawn(python, [bridgeScript], {
        cwd: bridgeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    }

    // Pipe stderr to our logger for diagnostics.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => log.debug(d.trim()));

    child.on('exit', (code) => {
      log.info(`bridge exited code=${code} session=${sessionId}`);
      this.sessions.delete(sessionId);
    });

    child.on('error', (err) => {
      log.error(`bridge spawn failed: ${err.message}`);
      this.onEvent({ kind: 'error', sessionId, message: `Python bridge 启动失败: ${err.message}` });
    });

    // Buffer for incomplete lines from stdout.
    const state = { child, buffer: '' };
    this.sessions.set(sessionId, state);

    // Read JSONL events from child stdout.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(sessionId, state, chunk));

    // Send the start message with config.
    const startMsg = JSON.stringify({
      type: 'start',
      session_id: sessionId,
      config: {
        model: cfg.model,
        base_url: cfg.baseUrl || this.opts.baseUrl,
        api_key: cfg.apiKey || this.opts.apiKey,
        workspace_dir: cfg.cwd || process.cwd(),
        system_prompt: cfg.systemPrompt || undefined,
      },
      prompt: cfg.initialPrompt || '',
      history: cfg.history || [],
    }) + '\n';

    child.stdin.write(startMsg);

    this.onEvent({ kind: 'thread_started', sessionId, threadId: sessionId });
    log.info(`session ${sessionId} started (uv=${!!uvPath})`);
    return { sessionId };
  }

  /**
   * Send a user prompt to the running agent.
   */
  sendPrompt(sessionId, text) {
    const state = this.sessions.get(sessionId);
    if (!state || !state.child) {
      this.onEvent({ kind: 'error', sessionId, message: 'Session not started' });
      return;
    }
    this.onEvent({ kind: 'turn_started', sessionId });
    const msg = JSON.stringify({ type: 'start', session_id: sessionId, prompt: text }) + '\n';
    state.child.stdin.write(msg);
  }

  /**
   * Cancel the running turn.
   */
  interrupt(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state || !state.child) return;
    const msg = JSON.stringify({ type: 'cancel', session_id: sessionId }) + '\n';
    state.child.stdin.write(msg);
    // Also send SIGTERM for immediate effect.
    state.child.kill('SIGTERM');
  }

  respondApproval(/* requestId, decision */) {
    // AgentMate does not use interactive approvals.
  }

  dispose(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.child) {
      try { state.child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }
    this.sessions.delete(sessionId);
  }

  disposeAll() {
    for (const [id, state] of this.sessions) {
      try { state.child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }
    this.sessions.clear();
  }

  // ── private ──────────────────────────────────────────────────────────

  _findUv() {
    // Check common locations for the `uv` binary.
    const candidates = [
      process.env.UV_PATH,
      '/Users/bruis/.local/bin/uv',
      '/usr/local/bin/uv',
      '/opt/homebrew/bin/uv',
      'uv', // PATH fallback
    ];
    for (const c of candidates) {
      if (c) {
        try {
          require('child_process').execFileSync(c, ['--version'], { stdio: 'pipe', timeout: 3000 });
          return c;
        } catch (_) { /* try next */ }
      }
    }
    return null;
  }

  /**
   * Process a chunk of stdout data from the bridge process.
   * Lines may be split across chunks, so we buffer.
   */
  _onStdout(sessionId, state, chunk) {
    state.buffer += chunk;
    const lines = state.buffer.split('\n');
    // The last element may be incomplete — keep it in the buffer.
    state.buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this._dispatch(sessionId, msg);
      } catch (_) {
        log.debug(`non-JSON stdout: ${trimmed.slice(0, 120)}`);
      }
    }
  }

  /**
   * Dispatch a single JSONL message from the bridge to the onEvent callback.
   */
  _dispatch(sessionId, msg) {
    switch (msg.type) {
      case 'thread_started':
        this.onEvent({ kind: 'thread_started', sessionId, threadId: msg.session_id });
        return;

      case 'turn_completed':
        this.onEvent({ kind: 'turn_completed', sessionId, usage: msg.usage });
        return;

      case 'turn_failed':
        this.onEvent({ kind: 'turn_failed', sessionId, message: msg.message });
        return;

      case 'item':
        this.onEvent({ kind: 'item', sessionId, phase: msg.phase, item: msg.item, usage: msg.usage });
        return;

      case 'error':
        this.onEvent({ kind: 'error', sessionId, message: msg.message });
        return;

      default:
        log.debug(`unknown bridge event: ${msg.type}`);
    }
  }
}

module.exports = { AgentmateAdapter };
