'use strict';

/**
 * Generate TypeScript protocol types from `codex app-server` for calibrating
 * the field names in `normalizeAppServerItem()` (appServerAdapter.js).
 *
 * Usage:
 *   node scripts/gen-protocol.js [--out <dir>]
 *
 * If codex is not installed, the script exits with a warning (no error) so it
 * works as a no-op in CI / fresh checkouts.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const outDir = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1] || 'src/main/engine/generated')
  : path.resolve(__dirname, '..', 'src/main/engine/generated');

const codexBin = process.env.OPEN_CODEX_CLI || 'codex';

let version = 'unknown';
try {
  version = execFileSync(codexBin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
} catch (err) {
  console.warn(`⚠ codex CLI not found (${codexBin}): skipping protocol generation.`);
  console.warn('  Install @openai/codex and run "codex login" first.');
  process.exit(0);
}

console.log(`Using codex: ${version}`);

// Ensure output directory exists.
fs.mkdirSync(outDir, { recursive: true });

// We generate types into a temp directory then move the relevant file.
// `codex app-server generate-ts` writes one or more .ts files.
try {
  execFileSync(codexBin, ['app-server', 'generate-ts', '--out', outDir], {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 30_000,
  });
  console.log(`Protocol types written to ${outDir}`);
} catch (err) {
  console.error(`✗ Failed to generate protocol types: ${err.message}`);
  console.error('  The app-server adapter field names may need manual calibration.');
  process.exit(1);
}

// List generated files for convenience.
const generated = fs.readdirSync(outDir).filter((f) => f.endsWith('.ts'));
if (generated.length === 0) {
  console.warn('⚠ No .ts files were generated — the codex CLI may have changed its output format.');
} else {
  console.log('Generated files:');
  for (const f of generated) console.log(`  ${f}`);
}

console.log('\nNext: diff the generated types against normalizeAppServerItem() in');
console.log('  src/main/engine/appServerAdapter.js');
console.log('to ensure field names match the live protocol.');
