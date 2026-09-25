#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JsonlAuditStore } from '@77systems/receipts-core';
import { createReceiptsServer, startHttpServer } from './index.js';

async function main(): Promise<void> {
  let transport = 'stdio';
  let port = 3100;
  let auditPath: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Receipts MCP\nUsage: receipts-mcp [--transport stdio|http] [--port 3100] [--audit-path FILE]\nHTTP listens only on 127.0.0.1 at /mcp. Audit path defaults to RECEIPTS_AUDIT_PATH or the core local default.\n');
      return;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    if (arg === '--transport' && ['stdio', 'http'].includes(value)) transport = value;
    else if (arg === '--port' && /^\d+$/.test(value) && Number(value) > 0 && Number(value) < 65536) port = Number(value);
    else if (arg === '--audit-path') auditPath = value;
    else throw new Error(`Invalid option: ${arg} ${value}. Use --help.`);
  }
  const options = auditPath ? { store: new JsonlAuditStore(auditPath) } : {};
  let close: () => Promise<void>;
  if (transport === 'http') {
    const running = await startHttpServer({ ...options, port });
    process.stderr.write(`Receipts MCP listening at ${running.url}\n`);
    close = () => running.close();
  } else {
    const server = createReceiptsServer(options);
    await server.connect(new StdioServerTransport());
    close = () => server.close();
  }
  const shutdown = () => { void close().then(() => process.exit(0)).catch(() => process.exit(1)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ error: { code: 'startup_failed', message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
});
