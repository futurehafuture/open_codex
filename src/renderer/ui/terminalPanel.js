'use strict';

/**
 * TerminalPanel — xterm.js-based real terminal replacing the old character-by-
 * character keydown handler. Connects to the node-pty backend via the same
 * IPC bridge: `terminal:create` / `terminal:write` / `terminal:resize` /
 * `terminal:data` / `terminal:exit` / `terminal:dispose`.
 *
 * Requires:
 *   <link rel="stylesheet" href="../node_modules/@xterm/xterm/css/xterm.css">
 *   <script src="../node_modules/@xterm/xterm/lib/xterm.js"></script>
 *   <script src="../node_modules/@xterm/addon-fit/lib/addon-fit.js"></script>
 *
 * Classic browser script, attaches to `window.TerminalPanel`.
 */
(function () {
  const Terminal = window.Terminal;
  const FitAddon = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);

  class TerminalPanel {
    /**
     * @param {HTMLElement} container — the DOM element to mount xterm into
     * @param {typeof window.openCodex} api
     * @param {{fontSize?: number, cursorBlink?: boolean}} [opts]
     */
    constructor(container, api, opts = {}) {
      this.container = container;
      this.api = api;
      this.terminalId = null;
      this.exitCode = null;
      this._unsubData = null;
      this._unsubExit = null;

      // Guard: xterm.js may fail to load (missing node_modules, CSP, etc.).
      if (!Terminal || !FitAddon) {
        this.term = null;
        this._fitAddon = null;
        this._resizeObserver = null;
        container.textContent = '终端组件未加载（请运行 npm install 安装依赖）。';
        return;
      }

      const fitAddon = new FitAddon();

      this.term = new Terminal({
        fontSize: opts.fontSize || 14,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursorBlink: opts.cursorBlink !== false,
        theme: {
          background: '#ffffff',
          foreground: '#202124',
          cursor: '#111111',
          selectionBackground: '#c7c9cc',
        },
      });

      this.term.loadAddon(fitAddon);
      this.term.open(container);

      // Fit to container on first render and on resize.
      this._fitAddon = fitAddon;
      this._resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          if (this.terminalId) {
            this.api.resizeTerminal(this.terminalId, this.term.cols, this.term.rows);
          }
        } catch (_) {
          // ResizeObserver may fire before the terminal is fully open.
        }
      });
      this._resizeObserver.observe(container);

      // xterm -> pty: every keystroke is forwarded to the backend.
      this.term.onData((data) => {
        if (this.terminalId) this.api.writeTerminal(this.terminalId, data);
      });
    }

    /** Launch the backend pty and connect it to xterm. */
    async start(cwd) {
      if (!this.term) return;
      // Dispose previous session if any.
      if (this.terminalId) {
        this.api.disposeTerminal(this.terminalId);
        this.terminalId = null;
      }
      this.exitCode = null;
      this.term.reset();

      const termInfo = await this.api.createTerminal(cwd);
      if (!termInfo) return;
      this.terminalId = termInfo.id;

      // pty -> xterm
      this._unsubData = this.api.onTerminalData(({ id, data }) => {
        if (id !== this.terminalId) return;
        this.term.write(data);
      });

      this._unsubExit = this.api.onTerminalExit(({ id, exitCode }) => {
        if (id !== this.terminalId) return;
        this.exitCode = exitCode;
        this.term.write(`\r\n[进程已退出，代码 ${exitCode}]\r\n`);
        this.terminalId = null;
      });
    }

    /** Resize xterm to fit its container, then notify the pty. */
    fit() {
      if (!this.term) return;
      try {
        this._fitAddon.fit();
        if (this.terminalId) {
          this.api.resizeTerminal(this.terminalId, this.term.cols, this.term.rows);
        }
      } catch (_) { /* ignore */ }
    }

    focus() {
      if (this.term) this.term.focus();
    }

    dispose() {
      if (!this.term) return;
      if (this._unsubData) { this._unsubData(); this._unsubData = null; }
      if (this._unsubExit) { this._unsubExit(); this._unsubExit = null; }
      if (this.terminalId) {
        this.api.disposeTerminal(this.terminalId);
        this.terminalId = null;
      }
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
      this.term.dispose();
    }

    /** Whether the backend pty is still running. */
    isAlive() {
      return this.term !== null && this.terminalId !== null && this.exitCode === null;
    }
  }

  window.TerminalPanel = {
    create: (container, api, opts) => new TerminalPanel(container, api, opts),
  };
})();
