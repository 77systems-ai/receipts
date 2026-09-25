#!/usr/bin/env node
import { JsonlAuditStore } from '@77systems/receipts-core';
import { createGitHubIssuesConnector } from '@77systems/receipts-github';
import { startRestServer } from './index.js';

async function main(): Promise<void> {
  let port = 3101;
  let auditPath: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Receipts REST\nUsage: receipts-rest [--port 3101] [--audit-path FILE]\nListens only on 127.0.0.1. Audit path defaults to RECEIPTS_AUDIT_PATH or the core local default.\n');
      return;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    if (arg === '--port' && /^\d+$/.test(value) && Number(value) > 0 && Number(value) < 65536) port = Number(value);
    else if (arg === '--audit-path') auditPath = value;
    else throw new Error(`Invalid option: ${arg} ${value}. Use --help.`);
  }
  const repository = process.env.RECEIPTS_GITHUB_REPO?.split('/');
  if(repository && repository.length!==2) throw new Error('RECEIPTS_GITHUB_REPO must be owner/repo.');
  const connectors = repository ? [createGitHubIssuesConnector({owner:repository[0]!,repo:repository[1]!})] : [];
  const running = await startRestServer({ port, connectors, ...(auditPath ? { store: new JsonlAuditStore(auditPath) } : {}) });
  process.stderr.write(`Receipts REST listening at ${running.url}\n`);
  const shutdown = () => { void running.close().then(() => process.exit(0)).catch(() => process.exit(1)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: { code: 'startup_failed', message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
});
