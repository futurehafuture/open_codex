const fs = require('fs');
const html = fs.readFileSync('src/renderer.html', 'utf8');
for (const id of ['workspaceButton', 'terminalButton', 'toolsButton', 'terminalOutput']) {
  if (!html.includes(`id="${id}"`)) {
    throw new Error(`Missing required UI element: ${id}`);
  }
}
console.log('renderer.html contains required Open Codex controls');
