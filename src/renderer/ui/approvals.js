'use strict';

/**
 * ApprovalsModal — interactive approval dialog for app-server mode.
 *
 * When the agent wants to run a command or edit a file under a gated policy,
 * the engine emits an `approval_request` event. This modal presents the details
 * and lets the user accept / accept-for-session / decline / cancel.
 *
 * Classic browser script, attaches to `window.ApprovalsModal`.
 */
(function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  class ApprovalsModal {
    /**
     * @param {typeof window.openCodex} api
     */
    constructor(api) {
      this.api = api;
      this.overlay = null;
    }

    /**
     * Show an approval request.
     * @param {{requestId:number, type:string, command?:string, cwd?:string, reason?:string, changes?:Array<{path:string, kind:string}>}} approval
     */
    show(approval) {
      if (!approval) return;
      this.close();
      this._build(approval);
    }

    close() {
      if (this.overlay) {
        this.overlay.remove();
        this.overlay = null;
      }
    }

    _decide(requestId, decision) {
      this.api.respondApproval(requestId, decision);
      this.close();
    }

    _build(approval) {
      const overlay = el('div', 'approval-overlay');
      const modal = el('div', 'approval-modal');

      // Header ---------------------------------------------------------------
      const isCommand = approval.type === 'command';
      modal.appendChild(el('h2', 'approval-title', isCommand ? '批准命令执行' : '批准文件改动'));
      if (approval.reason) {
        modal.appendChild(el('p', 'approval-reason', approval.reason));
      }

      // Body -----------------------------------------------------------------
      const body = el('div', 'approval-body');

      if (isCommand) {
        if (approval.cwd) {
          const cwdLine = el('div', 'approval-meta');
          cwdLine.appendChild(el('span', 'approval-label', '工作目录：'));
          cwdLine.appendChild(el('code', 'approval-code', approval.cwd));
          body.appendChild(cwdLine);
        }
        if (approval.command) {
          const cmdBlock = el('pre', 'approval-cmd', approval.command);
          body.appendChild(cmdBlock);
        }
      } else if (approval.changes && approval.changes.length > 0) {
        const list = el('div', 'approval-changes');
        for (const change of approval.changes) {
          const row = el('div', 'approval-change-row');
          const tag = el('span', `approval-tag ${change.kind || ''}`, change.kind || 'modified');
          const filePath = el('span', 'approval-path', change.path || '');
          row.appendChild(tag);
          row.appendChild(filePath);
          list.appendChild(row);
        }
        body.appendChild(list);
      }

      modal.appendChild(body);

      // Actions --------------------------------------------------------------
      const actions = el('div', 'approval-actions');
      const decline = el('button', 'btn approval-decline', '拒绝');
      const cancel = el('button', 'btn ghost', '取消');
      const acceptSession = el('button', 'btn approval-session', '本次会话全部批准');
      const accept = el('button', 'btn primary', '批准');

      decline.addEventListener('click', () => this._decide(approval.requestId, 'decline'));
      cancel.addEventListener('click', () => this._decide(approval.requestId, 'cancel'));
      acceptSession.addEventListener('click', () => this._decide(approval.requestId, 'acceptForSession'));
      accept.addEventListener('click', () => this._decide(approval.requestId, 'accept'));

      actions.appendChild(decline);
      actions.appendChild(cancel);
      actions.appendChild(acceptSession);
      actions.appendChild(accept);
      modal.appendChild(actions);

      overlay.appendChild(modal);
      // Close on backdrop click only if the user explicitly clicks outside the modal.
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) this._decide(approval.requestId, 'cancel');
      });
      document.body.appendChild(overlay);
      this.overlay = overlay;

      // Focus the primary accept button for keyboard flow.
      accept.focus();
    }
  }

  window.ApprovalsModal = { create: (api) => new ApprovalsModal(api) };
})();
