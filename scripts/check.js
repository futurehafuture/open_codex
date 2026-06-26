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
  'newChatButton', 'terminalOutput', 'promptInput', 'sendPrompt', 'agentOutput',
  'projectList',
]) {
  if (!html.includes(`id="${id}"`)) fail(`renderer.html missing UI element: ${id}`);
}
for (const apiName of ['startEngine', 'sendPrompt', 'onEngineEvent', 'getConfig']) {
  if (!html.includes(`api.${apiName}`)) fail(`renderer.html not wired to engine API: ${apiName}`);
}

const settings = fs.readFileSync(path.join(root, 'src/renderer/ui/settings.js'), 'utf8');
if (!settings.includes('saveConfig')) fail('settings.js does not call saveConfig');

const sidebar = fs.readFileSync(path.join(root, 'src/renderer/ui/sidebar.js'), 'utf8');
if (!sidebar.includes('listProjects')) fail('sidebar.js does not call listProjects');

const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
for (const channel of [
  'engine:start', 'engine:prompt', 'engine:event', 'config:get', 'config:save',
  'store:listProjects', 'store:listThreads', 'store:listMessages',
]) {
  if (!preload.includes(channel)) fail(`preload.js missing IPC channel: ${channel}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('All Open Codex static checks passed');
