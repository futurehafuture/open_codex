'use strict';

/**
 * AgentView renders normalized engine events into a chat-style console.
 *
 * It is a classic browser script (no module loader) and attaches to
 * `window.AgentView`. Every node is built with createElement + textContent so
 * untrusted agent output (messages, command output, file paths) can never be
 * interpreted as HTML.
 */
(function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
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
          node.appendChild(el('div', 'bubble', item.text || ''));
          break;
        case 'reasoning': {
          const d = el('details', 'reasoning');
          d.appendChild(el('summary', null, '思考过程'));
          d.appendChild(el('div', 'reason-body', item.text || ''));
          node.appendChild(d);
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
            li.appendChild(el('span', 'box', t.completed ? '☑' : '☐'));
            li.appendChild(el('span', 'todo-text', t.text || ''));
            list.appendChild(li);
          });
          node.appendChild(list);
          break;
        }
        case 'web_search':
          node.appendChild(el('div', 'search', `🔍 ${item.query || ''}`));
          break;
        case 'mcp_tool_call':
          node.appendChild(el('div', 'tool', `🔧 ${item.command || ''}`));
          break;
        case 'error':
          node.classList.add('error');
          node.appendChild(el('div', 'block-title', '错误'));
          node.appendChild(el('div', 'error-body', item.text || ''));
          break;
        default:
          if (item.text) node.appendChild(el('div', 'bubble', item.text));
      }
    }

    /** Prominent error block — the most common first-run failure is a bad URL/key. */
    renderError(message) {
      const node = el('div', 'block error');
      node.appendChild(el('div', 'block-title', '运行出错'));
      node.appendChild(el('div', 'error-body', message));
      node.appendChild(el('div', 'error-hint', '若是首次使用，请检查“设置”中的 Base URL 与 API Key 是否正确。'));
      if (this.opts.onOpenSettings) {
        const btn = el('button', 'error-btn', '打开设置');
        btn.addEventListener('click', () => this.opts.onOpenSettings());
        node.appendChild(btn);
      }
      this.container.appendChild(node);
      this.scroll();
    }

    /** SDK mode never emits approvals; minimal placeholder for app-server (M2). */
    renderApproval(approval) {
      if (!approval) return;
      const node = el('div', 'block approval');
      node.appendChild(el('div', 'block-title', '需要批准'));
      if (approval.command) node.appendChild(el('pre', 'cmd-out', approval.command));
      node.appendChild(el('div', 'error-hint', '交互式审批将在 app-server 模式（M2）支持。'));
      this.container.appendChild(node);
      this.scroll();
    }
  }

  window.AgentView = { create: (container, opts) => new AgentView(container, opts) };
})();
