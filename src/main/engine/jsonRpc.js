'use strict';

const { EventEmitter } = require('events');

/**
 * Newline-delimited JSON-RPC 2.0 channel over a child process' stdio, matching
 * the `codex app-server` stdio transport (the `"jsonrpc":"2.0"` header is
 * omitted on the wire).
 *
 * Emits:
 *   'notification' (method, params)        server -> client, no id
 *   'request'      (id, method, params)    server -> client, expects a response
 *   'close'        ()
 */
class JsonRpcChannel extends EventEmitter {
  /**
   * @param {NodeJS.WritableStream} writable child stdin
   * @param {NodeJS.ReadableStream} readable child stdout
   */
  constructor(writable, readable) {
    super();
    this.writable = writable;
    this.nextId = 1;
    this.buffer = '';
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();

    readable.setEncoding('utf8');
    readable.on('data', (chunk) => this._onData(chunk));
    readable.on('close', () => this.emit('close'));
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON log line on stdout; ignore
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (typeof msg.id !== 'undefined' && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || 'JSON-RPC error'));
      else waiter.resolve(msg.result);
      return;
    }
    if (typeof msg.id !== 'undefined' && msg.method) {
      this.emit('request', msg.id, msg.method, msg.params || {});
      return;
    }
    if (msg.method) {
      this.emit('notification', msg.method, msg.params || {});
    }
  }

  _write(obj) {
    this.writable.write(`${JSON.stringify(obj)}\n`);
  }

  /** Fire-and-forget client -> server notification. */
  notify(method, params) {
    this._write({ method, params });
  }

  /** Client -> server request; resolves with the server result. */
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ id, method, params });
    });
  }

  /** Respond to a server-initiated request. */
  respond(id, result) {
    this._write({ id, result });
  }

  respondError(id, code, message) {
    this._write({ id, error: { code, message } });
  }

  rejectAll(reason) {
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
  }
}

module.exports = { JsonRpcChannel };
