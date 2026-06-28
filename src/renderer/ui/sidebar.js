'use strict';

/**
 * Sidebar renders real projects + threads from the store and lets the user
 * reopen a past conversation. Classic browser script (window.Sidebar). Thread
 * titles come from user prompts, so every node is built with textContent.
 */
(function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function projectRow(project) {
    const row = el('div', 'nav-row');
    row.appendChild(el('span', 'nav-icon', '▣'));
    row.appendChild(el('span', null, project.name || project.path));
    return row;
  }

  function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - Number(ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} 天`;
    if (day < 30) return `${Math.floor(day / 7)} 周`;
    return `${Math.floor(day / 30)} 个月`;
  }

  class Sidebar {
    /**
     * @param {HTMLElement} container
     * @param {typeof window.openCodex} api
     * @param {{onOpenThread?: (thread: object, project: object) => void}} [handlers]
     */
    constructor(container, api, handlers = {}) {
      this.container = container;
      this.api = api;
      this.handlers = handlers;
      // Monotonic refresh token: refresh() is async and can be triggered
      // concurrently (init + engine events). Without this, two interleaved
      // runs each clear once and then both append, rendering the list twice.
      this._token = 0;
    }

    async refresh() {
      const token = ++this._token;
      let projects = [];
      try {
        projects = await this.api.store.listProjects();
      } catch (err) {
        projects = [];
      }
      // Fetch every project's threads before touching the DOM, so the render
      // happens in a single synchronous pass.
      const groups = [];
      for (const project of projects || []) {
        let threads = [];
        try {
          threads = await this.api.store.listThreads(project.id);
        } catch (err) {
          threads = [];
        }
        groups.push({ project, threads });
      }
      // A newer refresh started while we were awaiting — drop this stale render.
      if (token !== this._token) return;

      const frag = document.createDocumentFragment();
      if (groups.length === 0) {
        frag.appendChild(projectRow({ name: 'open_codex' }));
        frag.appendChild(el('div', 'conversation', '暂无对话'));
      } else {
        for (const { project, threads } of groups) {
          frag.appendChild(projectRow(project));
          if (!threads || threads.length === 0) {
            frag.appendChild(el('div', 'conversation', '暂无对话'));
            continue;
          }
          const list = el('div', 'history');
          const seen = new Set();
          for (const thread of threads) {
            if (seen.has(thread.id)) continue; // defend against duplicate rows
            seen.add(thread.id);
            const row = el('div', 'history-row clickable');
            row.appendChild(el('span', 'thread-title', thread.title || '新对话'));
            const right = el('span', 'row-right');
            right.appendChild(el('span', 'time', relTime(thread.updated_at)));
            const del = el('button', 'thread-del', '×');
            del.title = '删除会话';
            del.addEventListener('click', (ev) => {
              ev.stopPropagation(); // don't open the thread
              this.deleteThread(thread);
            });
            right.appendChild(del);
            row.appendChild(right);
            row.addEventListener('click', () => {
              if (this.handlers.onOpenThread) this.handlers.onOpenThread(thread, project);
            });
            list.appendChild(row);
          }
          frag.appendChild(list);
        }
      }
      this.container.textContent = '';
      this.container.appendChild(frag);
    }

    /** Delete a thread after confirmation, then refresh and notify the host. */
    async deleteThread(thread) {
      const name = thread.title || '新对话';
      if (!window.confirm(`删除会话「${name}」？此操作不可撤销。`)) return;
      try {
        await this.api.store.deleteThread(thread.id);
      } catch (err) {
        // best-effort; refresh reflects the real state regardless
      }
      if (this.handlers.onThreadDeleted) this.handlers.onThreadDeleted(thread.id);
      this.refresh();
    }
  }

  window.Sidebar = { create: (container, api, handlers) => new Sidebar(container, api, handlers) };
})();
