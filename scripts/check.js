'use strict';

/**
 * Static checks for Open Codex. Runs without installing dependencies:
 *  1. node --check (syntax) on every project .js file
 *  2. renderer.html exposes the expected controls and is wired to the bridge
 *  3. preload.js bridges the engine + config IPC channels
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
let failures = 0;

function fail(msg) {
  console.error(`✗ ${msg}`);
  failures += 1;
}

/** Recursively collect .js files, skipping node_modules and dotfiles. */
function jsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

for (const file of [...jsFiles(path.join(root, 'src')), ...jsFiles(path.join(root, 'scripts'))]) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    fail(`syntax error in ${path.relative(root, file)}: ${detail}`);
  }
}

const html = fs.readFileSync(path.join(root, 'src/renderer.html'), 'utf8');
for (const id of [
  'workspaceButton', 'terminalButton', 'toolsButton', 'settingsButton',
  'newChatButton', 'terminalMount', 'promptInput', 'sendPrompt', 'agentOutput',
  'projectList',
]) {
  if (!html.includes(`id="${id}"`)) fail(`renderer.html missing UI element: ${id}`);
}
for (const apiName of ['startEngine', 'sendPrompt', 'onEngineEvent', 'getConfig']) {
  if (!html.includes(`api.${apiName}`)) fail(`renderer.html not wired to engine API: ${apiName}`);
}

const settings = fs.readFileSync(path.join(root, 'src/renderer/ui/settings.js'), 'utf8');
if (!settings.includes('saveConfig')) fail('settings.js does not call saveConfig');
if (!settings.includes('engineMode')) fail('settings.js missing engineMode selector');

const approvals = fs.readFileSync(path.join(root, 'src/renderer/ui/approvals.js'), 'utf8');
if (!approvals.includes('respondApproval')) fail('approvals.js does not call respondApproval');
if (!approvals.includes('ApprovalsModal')) fail('approvals.js missing ApprovalsModal export');

const sidebar = fs.readFileSync(path.join(root, 'src/renderer/ui/sidebar.js'), 'utf8');
if (!sidebar.includes('listProjects')) fail('sidebar.js does not call listProjects');

const agentView = fs.readFileSync(path.join(root, 'src/renderer/ui/agentView.js'), 'utf8');
if (!agentView.includes('onApprovalRequest')) fail('agentView.js missing onApprovalRequest wiring');

const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
for (const channel of [
  'engine:start', 'engine:prompt', 'engine:event', 'config:get', 'config:save',
  'store:listProjects', 'store:listThreads', 'store:listMessages',
  'engine:respond-approval',
]) {
  if (!preload.includes(channel)) fail(`preload.js missing IPC channel: ${channel}`);
}

// Verify M2 renderer wiring -------------------------------------------------
if (!html.includes('approvals.js')) fail('renderer.html missing approvals.js script');
if (!html.includes('ApprovalsModal')) fail('renderer.html missing ApprovalsModal wiring');
if (!html.includes('onApprovalRequest')) fail('renderer.html missing onApprovalRequest callback');

// Verify M3 terminal & packaging ---------------------------------------------
const terminalPanel = fs.readFileSync(path.join(root, 'src/renderer/ui/terminalPanel.js'), 'utf8');
if (!terminalPanel.includes('TerminalPanel')) fail('terminalPanel.js missing TerminalPanel export');

if (!html.includes('xterm.css')) fail('renderer.html missing xterm CSS link');
if (!html.includes('xterm.js')) fail('renderer.html missing xterm.js script');
if (!html.includes('addon-fit.js')) fail('renderer.html missing addon-fit.js script');
if (!html.includes('terminalPanel.js')) fail('renderer.html missing terminalPanel.js script');

for (const channel of ['terminal:create', 'terminal:write', 'terminal:data', 'terminal:exit',
                        'terminal:resize', 'terminal:dispose']) {
  if (!preload.includes(channel)) fail(`preload.js missing terminal IPC channel: ${channel}`);
}

if (!fs.existsSync(path.join(root, 'electron-builder.yml'))) {
  fail('electron-builder.yml not found');
}

// Verify agentmate engine integration ---------------------------------------
const agentmateAdapter = fs.readFileSync(path.join(root, 'src/main/engine/adapters/agentmateAdapter.js'), 'utf8');
if (!agentmateAdapter.includes('AgentmateAdapter')) fail('agentmateAdapter.js missing AgentmateAdapter export');
const agentmateBridge = fs.readFileSync(path.join(root, 'src/main/engine/agentmate-python/bridge.py'), 'utf8');
if (!agentmateBridge.includes('punctuation') || !agentmateBridge.includes('without using tools')) {
  fail('agentmate bridge prompt missing ambiguous-input tool guard');
}

if (!fs.existsSync(path.join(root, 'src/main/engine/agentmate-python/bridge.py'))) {
  fail('agentmate-python/bridge.py not found');
}
if (!fs.existsSync(path.join(root, 'src/main/engine/agentmate-python/pyproject.toml'))) {
  fail('agentmate-python/pyproject.toml not found');
}
if (!fs.existsSync(path.join(root, 'src/main/engine/agentmate-python/agentmate/__init__.py'))) {
  fail('agentmate-python/agentmate package not found');
}

const engineIndex = fs.readFileSync(path.join(root, 'src/main/engine/index.js'), 'utf8');
if (!engineIndex.includes('AgentmateAdapter')) fail('engine/index.js missing AgentmateAdapter import');

const typesJs = fs.readFileSync(path.join(root, 'src/main/engine/types.js'), 'utf8');
if (!typesJs.includes("AGENTMATE: 'agentmate'")) fail('types.js missing AGENTMATE in EngineMode');

const configStore = fs.readFileSync(path.join(root, 'src/main/config/store.js'), 'utf8');
if (!configStore.includes("'agentmate'")) fail('config/store.js missing agentmate in valid engine modes');

if (!settings.includes('agentmate')) fail('settings.js missing agentmate engine mode option');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('All Open Codex static checks passed');
