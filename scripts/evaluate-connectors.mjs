#!/usr/bin/env node
// Regenerate the public conformance evaluations for the bundled connectors on purpose.
// Ordinary `npm test` runs write their evaluations under ignored .receipts/ so these
// artifacts never change as a side effect of testing on another Node version or platform.
// Review the diff (environment provenance, digest) before committing; a publication
// declaration pins the digest of the exact published file.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const connectors = [['github', 'connector-github'], ['file', 'connector-file'], ['gmail', 'connector-gmail']];
let failed = 0;
for (const [name, directory] of connectors) {
  const { version } = JSON.parse(readFileSync(resolve(root, 'packages', directory, 'package.json'), 'utf8'));
  const target = resolve(root, 'docs/evaluations', `${name}-${version}.json`);
  const test = resolve(root, 'packages', directory, 'tests', `${name}.test.ts`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', test], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, RECEIPTS_EVALUATION_PATH: target },
  });
  // The committed-evaluation check inside the test reads the file it is replacing, so judge the
  // written artifact, not the exit status, on the first run of a new version.
  process.stdout.write(`${name}: ${target} (test exit ${result.status})\n`);
  if (result.status !== 0) failed++;
}
if (failed) process.stdout.write('A connector test failed. If only the committed-evaluation check failed because the file is new, rerun once; otherwise inspect the output above.\n');
process.exitCode = failed ? 1 : 0;
