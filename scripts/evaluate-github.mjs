#!/usr/bin/env node
// Regenerate the public GitHub conformance evaluation on purpose. Ordinary `npm test`
// runs write their evaluation under ignored .receipts/ so this artifact never changes
// as a side effect of testing on a different Node version or platform. Review the diff
// (environment provenance, digest) before committing; a publication declaration pins
// the digest of the exact published file.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'docs/evaluations/github-0.3.0.json');
const test = resolve(root, 'packages/connector-github/tests/github.test.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', test], {
  cwd: root, stdio: 'inherit', env: { ...process.env, RECEIPTS_EVALUATION_PATH: target },
});
if (result.status === 0) process.stdout.write(`Evaluation written to ${target}\n`);
process.exitCode = result.status ?? 1;
