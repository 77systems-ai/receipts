import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const built = new URL('../dist/hook.js', import.meta.url);
if (existsSync(fileURLToPath(built))) {
  await import(built.href);
} else {
  const result = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', '--package', '@77systems/receipts-claude-plugin@0.1.0', 'receipts-hook'],
    { input: readFileSync(0), maxBuffer: 2 * 1024 * 1024, timeout: 25000 });
  process.stdout.write(result);
}
