#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RECEIPTS_TOOL_NAMES } from './index.js';

export interface DoctorCheck { check: string; ok: boolean; detail: string }

/** Boot the real MCP executable and inspect its tools, without reading a destination. */
export async function doctor(): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [{ check: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: 'Node.js 20 or newer is required.' }];
  const tokenPresent = Boolean(process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim());
  checks.push({ check: 'github_credentials', ok: tokenPresent, detail: tokenPresent ? 'A local token is present. Its value and permissions were not inspected.' : 'Set GITHUB_TOKEN or GH_TOKEN locally.' });
  const repositoryReady = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(process.env.RECEIPTS_GITHUB_REPO ?? '');
  checks.push({ check: 'github_repository', ok: repositoryReady, detail: repositoryReady ? 'A destination repository is configured.' : 'Set RECEIPTS_GITHUB_REPO to owner/repo.' });
  const client = new Client({ name: 'receipts-doctor', version: '0.3.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url))],
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string')), stderr: 'pipe' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect(transport);
        checks.push({ check: 'mcp_boot', ok: true, detail: 'The MCP server started and completed its handshake.' });
        const actual = (await client.listTools()).tools.map(tool => tool.name).sort();
        const expected = [...RECEIPTS_TOOL_NAMES].sort();
        const ok = JSON.stringify(actual) === JSON.stringify(expected);
        checks.push({ check: 'mcp_tools', ok, detail: ok ? `All ${expected.length} expected tools are available.` : 'The expected tool list did not match.' });
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); }),
    ]);
  } catch {
    checks.push({ check: 'mcp_connection', ok: false, detail: 'The MCP server could not boot or list tools. Rebuild or reinstall the package and check local configuration.' });
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
  return { ok: checks.every(check => check.ok), checks };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: receipts doctor\nChecks Node, MCP startup/tools, and local GitHub credential presence. Never prints credential values or calls GitHub.\n');
  } else if (args.length > 1 || (args[0] !== undefined && args[0] !== 'doctor')) {
    process.stderr.write('Usage: receipts doctor\n');
    process.exitCode = 1;
  } else {
    const report = await doctor();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }
}
