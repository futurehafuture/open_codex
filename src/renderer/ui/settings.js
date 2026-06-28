'use strict';

/**
 * SettingsModal lets the user point Open Codex at any OpenAI-compatible
 * endpoint: a Base URL + API Key (+ optional model). Classic browser script,
 * attaches to `window.SettingsModal`. The raw API key is write-only from the
 * renderer's perspective — the main process only ever returns `hasApiKey`.
 */
(function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function field(parent, label, type, value, placeholder) {
    const wrap = el('label', 'settings-field');
    wrap.appendChild(el('span', 'settings-label', label));
    const input = document.createElement('input');
    input.type = type;
    input.value = value || '';
    input.placeholder = placeholder || '';
    input.className = 'settings-input';
    if (type === 'password') input.autocomplete = 'off';
    wrap.appendChild(input);
    parent.appendChild(wrap);
    return input;
  }

  class SettingsModal {
    /** @param {typeof window.openCodex} api */
    constructor(api) {
      this.api = api;
      this.overlay = null;
    }

    /** @param {(settings: object) => void} [onSaved] */
    async open(onSaved) {
      const cfg = await this.api.getConfig();
      this._build(cfg, onSaved);
    }

    close() {
      if (this.overlay) {
        this.overlay.remove();
        this.overlay = null;
      }
    }

    _build(cfg, onSaved) {
      this.close();
      const overlay = el('div', 'settings-overlay');
      const modal = el('div', 'settings-modal');

      modal.appendChild(el('h2', 'settings-title', '设置'));
      modal.appendChild(
        el('p', 'settings-sub', '使用任意兼容 OpenAI 接口的服务：填写 Base URL 与 API Key 即可驱动 Codex agent。'),
      );

      const baseUrl = field(modal, 'Base URL', 'url', cfg.baseUrl, 'https://api.openai.com/v1');
      const apiKey = field(
        modal,
        'API Key',
        'password',
        '',
        cfg.hasApiKey ? '已保存（未显示，留空则保持不变）' : 'sk-...',
      );
      const model = field(modal, '模型（可选）', 'text', cfg.model, '如 gpt-4o、deepseek-chat');

      // Engine mode — radio group -------------------------------------------
      const modeWrap = el('label', 'settings-field');
      modeWrap.appendChild(el('span', 'settings-label', '引擎模式'));
      const modeRow = el('div', 'settings-radio-row');
      const sdkLabel = el('label', 'settings-radio-label');
      const sdkRadio = document.createElement('input');
      sdkRadio.type = 'radio';
      sdkRadio.name = 'engineMode';
      const amLabel = el('label', 'settings-radio-label');
      const amRadio = document.createElement('input');
      amRadio.type = 'radio';
      amRadio.name = 'engineMode';
      amRadio.value = 'agentmate';
      amRadio.checked = !cfg.engineMode || cfg.engineMode === 'agentmate';
      amLabel.appendChild(amRadio);
      amLabel.appendChild(el('span', null, 'AgentMate（通用兼容，DeepSeek 等）'));
      modeRow.appendChild(amLabel);
      sdkRadio.value = 'sdk';
      sdkRadio.checked = cfg.engineMode === 'sdk';
      sdkLabel.appendChild(sdkRadio);
      sdkLabel.appendChild(el('span', null, 'Codex SDK（OpenAI 专用）'));
      modeRow.appendChild(sdkLabel);
      const asLabel = el('label', 'settings-radio-label');
      const asRadio = document.createElement('input');
      asRadio.type = 'radio';
      asRadio.name = 'engineMode';
      asRadio.value = 'app-server';
      asRadio.checked = cfg.engineMode === 'app-server';
      asLabel.appendChild(asRadio);
      asLabel.appendChild(el('span', null, 'Codex App-Server（交互式审批）'));
      modeRow.appendChild(asLabel);
      modeWrap.appendChild(modeRow);
      modal.appendChild(modeWrap);

      const errLine = el('div', 'settings-error');
      modal.appendChild(errLine);

      const actions = el('div', 'settings-actions');
      const cancel = el('button', 'btn ghost', '取消');
      const save = el('button', 'btn primary', '保存');
      cancel.addEventListener('click', () => this.close());
      save.addEventListener('click', async () => {
        errLine.textContent = '';
        const engineMode = amRadio.checked ? 'agentmate' : (sdkRadio.checked ? 'sdk' : 'app-server');
        const patch = { baseUrl: baseUrl.value.trim(), model: model.value.trim(), engineMode };
        if (apiKey.value !== '') patch.apiKey = apiKey.value.trim(); // empty = keep existing
        const res = await this.api.saveConfig(patch);
        if (!res || !res.ok) {
          errLine.textContent = (res && res.error) || '保存失败';
          return;
        }
        this.close();
        if (onSaved) onSaved(res.settings);
      });
      actions.appendChild(cancel);
      actions.appendChild(save);
      modal.appendChild(actions);

      overlay.appendChild(modal);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) this.close();
      });
      document.body.appendChild(overlay);
      this.overlay = overlay;
      baseUrl.focus();
    }
  }

  window.SettingsModal = { create: (api) => new SettingsModal(api) };
})();
