const fs = require('fs');
const html = fs.readFileSync('src/renderer.html', 'utf8');
for (const id of ['workspaceButton', 'terminalButton', 'toolsButton', 'terminalOutput', 'promptInput', 'sendPrompt', 'agentOutput']) {
  if (!html.includes(`id="${id}"`)) {
    throw new Error(`Missing required UI element: ${id}`);
  }
}
for (const api of ['startAgent', 'sendAgentPrompt', 'onAgentData']) {
  if (!html.includes(`openCodex.${api}`)) {
    throw new Error(`Renderer is not wired to agent API: ${api}`);
  }
}
console.log('renderer.html contains required Open Codex agent controls');
