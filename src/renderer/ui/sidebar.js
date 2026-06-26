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
    return `${Math.floor(day / 7)} 周`;
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
    }

    async refresh() {
      let projects = [];
      try {
        projects = await this.api.store.listProjects();
      } catch (err) {
        projects = [];
      }
      this.container.textContent = '';
      if (!projects || projects.length === 0) {
        this.container.appendChild(el('div', 'conversation', '暂无项目，选择工作目录并开始对话'));
        return;
      }
      for (const project of projects) {
        this.container.appendChild(el('div', 'nav-row', `▰ ${project.name || project.path}`));
        const threads = await this.api.store.listThreads(project.id);
        if (!threads || threads.length === 0) {
          this.container.appendChild(el('div', 'conversation', '暂无对话'));
          continue;
        }
        const list = el('div', 'history');
        for (const thread of threads) {
          const row = el('div', 'history-row clickable');
          row.appendChild(el('span', 'thread-title', thread.title || '新对话'));
          row.appendChild(el('span', 'time', relTime(thread.updated_at)));
          row.addEventListener('click', () => {
            if (this.handlers.onOpenThread) this.handlers.onOpenThread(thread, project);
          });
          list.appendChild(row);
        }
        this.container.appendChild(list);
      }
    }
  }

  window.Sidebar = { create: (container, api, handlers) => new Sidebar(container, api, handlers) };
})();
