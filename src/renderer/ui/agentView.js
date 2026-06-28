'use strict';

/**
 * AgentView renders normalized engine events into a chat-style console.
 *
 * Classic browser script (window.AgentView). Agent messages are rendered
 * through marked (GitHub-flavoured Markdown) with raw HTML stripped for safety.
 */
(function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // Configure marked for safe rendering (no raw HTML passthrough).
  const md = window.marked || {};
  if (md.setOptions) {
    md.setOptions({ breaks: true, gfm: true });
  } else {
    md.parse = md.parse || (function (t) { return t; });
  }

  /** Render markdown text to safe HTML. */
  function renderMarkdown(text) {
    if (!text) return '';
    // Strip raw HTML before passing to marked (defence in depth).
    const safe = String(text).replace(/<[^>]*>/g, '');
    try { return md.parse(safe); } catch (_) { return safe; }
  }

  /** Strip common markdown markers from plain-text display. */
  function stripMarkdown(text) {
    if (!text) return text;
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
      .replace(/\*(.+?)\*/g, '$1')        // italic
      .replace(/`(.+?)`/g, '$1')          // inline code
      .replace(/^#{1,6}\s+/gm, '')        // headings
      .replace(/^\s*[-*]\s+/gm, '')       // list bullets
      .replace(/^\s*\d+\.\s+/gm, '')      // numbered lists
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1'); // links
  }

  /**
   * Map a raw (often English) engine error to a friendly Chinese summary.
   * Returns { title, needsSettings }. `needsSettings` drives the hint + button.
   */
  function friendlyError(message) {
    const raw = String(message == null ? '' : message);
    const lower = raw.toLowerCase();
    if (
      lower.includes('missing credentials') ||
      lower.includes('api_key') || lower.includes('api key') ||
      lower.includes('admin_key') ||
      lower.includes('401') || lower.includes('unauthorized')
    ) {
      return { title: 'API 凭证缺失或无效，请检查 API Key', needsSettings: true };
    }
    if (
      lower.includes('base url') || lower.includes('baseurl') ||
      lower.includes('enotfound') || lower.includes('econnrefused') ||
      lower.includes('fetch failed') || lower.includes('network')
    ) {
      return { title: '无法连接到服务端，请检查 Base URL', needsSettings: true };
    }
    if (lower.includes('429') || lower.includes('rate limit')) {
      return { title: '请求过于频繁（限流），请稍后再试', needsSettings: false };
    }
    return { title: raw || '运行失败', needsSettings: false };
  }

  class AgentView {
    /**
     * @param {HTMLElement} container
     * @param {{onOpenSettings?: () => void}} [opts]
     */
    constructor(container, opts = {}) {
      this.container = container;
      this.opts = opts;
      /** @type {Map<string, {el: HTMLElement}>} item id -> rendered block */
      this.items = new Map();
      this.thinkingEl = null;
    }

    clear() {
      this.container.textContent = '';
      this.items.clear();
      this.thinkingEl = null;
    }

    scroll() {
      this.container.scrollTop = this.container.scrollHeight;
    }

    addUserMessage(text) {
      const row = el('div', 'msg user');
      row.appendChild(el('div', 'bubble', text));
      this.container.appendChild(row);
      this.scroll();
    }

    setThinking(on) {
      if (on && !this.thinkingEl) {
        this.thinkingEl = el('div', 'thinking', '思考中…');
        this.container.appendChild(this.thinkingEl);
      } else if (!on && this.thinkingEl) {
        this.thinkingEl.remove();
        this.thinkingEl = null;
      }
      this.scroll();
    }

    /** @param {import('../../main/engine/types').EngineEvent} event */
    handleEvent(event) {
      switch (event.kind) {
        case 'turn_started':
          this.setThinking(true);
          return;
        case 'turn_completed':
          this.setThinking(false);
          return;
        case 'turn_interrupted':
          this.setThinking(false);
          this.renderNotice('已停止生成');
          return;
        case 'turn_failed':
          this.setThinking(false);
          this.renderError(event.message || '运行失败');
          return;
        case 'error':
          this.setThinking(false);
          this.renderError(event.message || '发生错误');
          return;
        case 'item':
          this.renderItem(event.item, event.phase);
          return;
        case 'approval_request':
          this.renderApproval(event.approval);
          return;
        default:
          return;
      }
    }

    renderItem(item, phase) {
      if (!item || !item.id) return;
      let entry = this.items.get(item.id);
      if (!entry) {
        const node = el('div', 'block');
        this.container.appendChild(node);
        entry = { el: node };
        this.items.set(item.id, entry);
      }
      this.paint(entry.el, item, phase);
      this.setThinking(false);
      this.scroll();
    }

    /** Rebuild a block's contents from the latest item state (replace-by-id). */
    paint(node, item, phase) {
      node.textContent = '';
      node.className = `block ${item.type || ''} ${phase || ''}`.trim();
      switch (item.type) {
        case 'agent_message':
          node.classList.add('msg', 'agent');
          // Skip empty bubbles (item created before any text streams, or a turn
          // that failed mid-stream) so they don't render as floating gray ovals.
          if (item.text) {
            const bubble = el('div', 'bubble');
            bubble.innerHTML = renderMarkdown(item.text);
            node.appendChild(bubble);
          }
          break;
        case 'reasoning': {
          const body = stripMarkdown(item.text || '');
          const streaming = item.status === 'in_progress' || phase === 'updated';
          if (!body && !streaming) break;

          // Track start time on the item map entry so we can show duration
          // once reasoning completes.
          const entry = this.items.get(item.id);
          if (entry && !entry._reasoningStarted && streaming) {
            entry._reasoningStarted = Date.now();
          }

          const details = el('details', 'reasoning');
          details.open = streaming;

          const sum = el('summary', 'reasoning-summary');
          const dot = el('span', streaming ? 'reasoning-dot live' : 'reasoning-dot');
          sum.appendChild(dot);

          if (streaming) {
            sum.appendChild(el('span', 'reasoning-label', '思考中…'));
          } else {
            sum.appendChild(el('span', 'reasoning-label', '已思考'));
            const dur = entry && entry._reasoningStarted
              ? Math.max(1, Math.round((Date.now() - entry._reasoningStarted) / 1000))
              : null;
            const parts = [];
            if (dur !== null) parts.push(`${dur}s`);
            if (body) parts.push(`${body.length} 字`);
            sum.appendChild(el('span', 'reasoning-meta', `· ${parts.join(' · ')}`));
          }
          details.appendChild(sum);

          if (body) {
            details.appendChild(el('div', 'reasoning-body', body));
          }
          node.appendChild(details);
          break;
        }
        case 'command_execution': {
          const head = el('div', 'cmd-head');
          head.appendChild(el('span', 'cmd-prompt', '$'));
          head.appendChild(el('span', 'cmd-line', item.command || ''));
          if (item.exitCode !== undefined && item.exitCode !== null) {
            const ok = item.exitCode === 0;
            head.appendChild(el('span', `exit ${ok ? 'ok' : 'bad'}`, `exit ${item.exitCode}`));
          }
          node.appendChild(head);
          if (item.aggregatedOutput) node.appendChild(el('pre', 'cmd-out', item.aggregatedOutput));
          break;
        }
        case 'file_change': {
          node.appendChild(el('div', 'block-title', '文件改动'));
          const list = el('div', 'file-list');
          (item.changes || []).forEach((c) => {
            const row = el('div', 'file-row');
            row.appendChild(el('span', `tag ${c.kind || ''}`, c.kind || ''));
            row.appendChild(el('span', 'file-path', c.path || ''));
            list.appendChild(row);
          });
          node.appendChild(list);
          break;
        }
        case 'todo_list': {
          node.appendChild(el('div', 'block-title', '任务清单'));
          const list = el('ul', 'todo-list');
          (item.items || []).forEach((t) => {
            const li = el('li', t.completed ? 'done' : null);
            li.appendChild(el('span', 'box', t.completed ? '' : ''));
            li.appendChild(el('span', 'todo-text', t.text || ''));
            list.appendChild(li);
          });
          node.appendChild(list);
          break;
        }
        case 'web_search': {
          const card = el('div', 'tool-call search');
          card.appendChild(el('span', 'tool-call-icon', '🔍'));
          card.appendChild(el('span', 'tool-call-name', item.query || '搜索中…'));
          node.appendChild(card);
          break;
        }
        case 'mcp_tool_call': {
          const running = item.status === 'in_progress';
          const ok = item.status === 'completed';
          const bad = item.status === 'failed' || item.status === 'declined';

          const card = el('div', `tool-call ${running ? 'running' : ''} ${ok ? 'ok' : ''} ${bad ? 'bad' : ''}`);
          // Spinner / check / cross
          const ico = el('span', 'tool-call-icon');
          if (running) ico.innerHTML = '<span class="tc-spin"></span>';
          else if (ok) ico.textContent = '✓';
          else ico.textContent = '✗';
          card.appendChild(ico);

          const name = el('span', 'tool-call-name', item.command || 'tool_call');
          card.appendChild(name);

          // Show first argument line when completed (truncated).
          if (item.text && ok) {
            const detail = el('span', 'tool-call-args', item.text.slice(0, 120));
            card.appendChild(detail);
          }
          node.appendChild(card);
          break;
        }
        case 'error':
          node.classList.add('error');
          node.appendChild(el('div', 'block-title', '错误'));
          node.appendChild(el('div', 'error-body', item.text || ''));
          break;
        default:
          // Unknown item type — render a generic card so it never looks broken.
          if (item.text) {
            node.appendChild(el('div', 'bubble', stripMarkdown(item.text)));
          } else if (item.type) {
            const card = el('div', 'tool-call');
            card.appendChild(el('span', 'tool-call-icon', '·'));
            card.appendChild(el('span', 'tool-call-name', item.type));
            node.appendChild(card);
          }
      }
    }

    /** Prominent error block — the most common first-run failure is a bad URL/key. */
    renderError(message) {
      const raw = String(message == null ? '运行失败' : message) || '运行失败';
      // Collapse a repeated identical error into a single card with a ×N badge
      // instead of stacking a wall of identical red boxes.
      const last = this.container.lastElementChild;
      if (last && last.dataset && last.dataset.errorRaw === raw) {
        this.bumpErrorCount(last);
        this.scroll();
        return;
      }
      const info = friendlyError(raw);
      const node = el('div', 'block error');
      node.dataset.errorRaw = raw;
      node.appendChild(el('div', 'block-title', '运行出错'));
      node.appendChild(el('div', 'error-body', info.title));
      // Keep the raw engine text available for debugging, but tucked away.
      if (info.title !== raw) {
        const d = el('details', 'error-detail');
        d.appendChild(el('summary', null, '详情'));
        d.appendChild(el('div', 'error-raw', raw));
        node.appendChild(d);
      }
      if (info.needsSettings) {
        node.appendChild(el('div', 'error-hint', '请在「设置」中检查 Base URL 与 API Key 是否正确。'));
        if (this.opts.onOpenSettings) {
          const btn = el('button', 'error-btn', '打开设置');
          btn.addEventListener('click', () => this.opts.onOpenSettings());
          node.appendChild(btn);
        }
      }
      this.container.appendChild(node);
      this.scroll();
    }

    /** Increment the repeat counter on an already-rendered error card. */
    bumpErrorCount(node) {
      const n = (Number(node.dataset.errorCount) || 1) + 1;
      node.dataset.errorCount = String(n);
      let badge = node.querySelector('.error-count');
      if (!badge) {
        badge = el('span', 'error-count');
        const title = node.querySelector('.block-title');
        if (title) title.appendChild(badge);
      }
      badge.textContent = ` ×${n}`;
    }

    renderNotice(message) {
      const node = el('div', 'block notice', message);
      this.container.appendChild(node);
      this.scroll();
    }

    /**
     * Forward approval requests to the external handler (ApprovalsModal).
     * In SDK mode this is never called; in app-server mode it delegates to the
     * interactive dialog wired by the renderer bootstrap.
     */
    renderApproval(approval) {
      if (!approval) return;
      if (this.opts.onApprovalRequest) {
        this.opts.onApprovalRequest(approval);
      } else {
        // Fallback if no handler is wired (should not happen in normal flow).
        const node = el('div', 'block approval');
        node.appendChild(el('div', 'block-title', '需要批准'));
        if (approval.command) node.appendChild(el('pre', 'cmd-out', approval.command));
        node.appendChild(el('div', 'error-hint', '审批组件未加载。请确认 app-server 模式已正确配置。'));
        this.container.appendChild(node);
        this.scroll();
      }
    }
  }

  window.AgentView = { create: (container, opts) => new AgentView(container, opts) };
})();
