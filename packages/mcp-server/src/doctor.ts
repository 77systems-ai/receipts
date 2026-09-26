import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RECEIPTS_TOOL_NAMES } from './index.js';

export interface DoctorCheck { name: string; ok: boolean; detail: string }
export interface DoctorReport { ok: boolean; version: string; checks: DoctorCheck[] }

import { PACKAGE_VERSION } from './version.js';
export { PACKAGE_VERSION };

/** Boot the real MCP executable and inspect its tools, without reading a destination or printing any configured value. */
export async function doctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [{ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: 'Node.js 20 or newer is required.' }];
  const tokenPresent = Boolean(process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim());
  checks.push({ name: 'github_credentials', ok: tokenPresent, detail: tokenPresent ? 'A local token is present. Its value and permissions were not inspected.' : 'Set GITHUB_TOKEN or GH_TOKEN locally.' });
  const repositoryReady = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(process.env.RECEIPTS_GITHUB_REPO ?? '');
  checks.push({ name: 'github_repository', ok: repositoryReady, detail: repositoryReady ? 'A destination repository is configured.' : 'Set RECEIPTS_GITHUB_REPO to owner/repo.' });
  const client = new Client({ name: 'receipts-doctor', version: PACKAGE_VERSION });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url))],
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string')), stderr: 'pipe' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect(transport);
        checks.push({ name: 'mcp_boot', ok: true, detail: 'The MCP server started and completed its handshake.' });
        const actual = (await client.listTools()).tools.map(tool => tool.name).sort();
        const expected = [...RECEIPTS_TOOL_NAMES].sort();
        const ok = JSON.stringify(actual) === JSON.stringify(expected);
        checks.push({ name: 'mcp_tools', ok, detail: ok ? `All ${expected.length} expected tools are available.` : 'The expected tool list did not match.' });
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); }),
    ]);
  } catch {
    checks.push({ name: 'mcp_connection', ok: false, detail: 'The MCP server could not boot or list tools. Rebuild or reinstall the package and check local configuration.' });
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
  return { ok: checks.every(check => check.ok), version: PACKAGE_VERSION, checks };
}

/** Human-readable rendering. `--json` prints the report object instead. */
export function renderDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map(check => check.name.length));
  const lines = [`receipts doctor (@77systems/receipts-mcp ${report.version})`,
    ...report.checks.map(check => `  ${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.detail}`),
    `Result: ${report.ok ? 'ok' : 'problems found'}`];
  return `${lines.join('\n')}\n`;
}
