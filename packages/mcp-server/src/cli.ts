#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { delimiter } from 'node:path';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JsonlAuditStore, ReceiptsError, validatePolicy, type WritePolicy } from '@77systems/receipts-core';
import { configuredConnectors } from './runtime-connectors.js';
import { createReceiptsServer, startHttpServer, type ServerOptions } from './index.js';

const HELP = `Receipts MCP
Usage: receipts-mcp [--transport stdio|http] [--port 3100] [--audit-path FILE] [--policy FILE] [--claim-ttl MS] [--signing-key FILE]
HTTP listens only on 127.0.0.1 at /mcp. Audit path defaults to RECEIPTS_AUDIT_PATH or the core local default.
  --policy FILE       JSON WritePolicy applied at claim and dispatch (env RECEIPTS_POLICY_PATH). Host-owned; no tool call can change it.
  --claim-ttl MS      Positive integer TTL for unused claims (env RECEIPTS_CLAIM_TTL_MS). Dispatched claims never expire into another write.
  --signing-key FILE  PEM PKCS8 Ed25519 private key enabling receipts.sign and receipts.badge (env RECEIPTS_SIGNING_KEY_PATH). Keep it mode 0600; it never leaves this process.
Flags override environment variables.
`;

/** Error messages name the path and the failure, never the file contents. */
function loadPolicy(path: string): WritePolicy {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { throw new Error(`The policy file at ${path} could not be read.`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`The policy file at ${path} is not valid JSON.`); }
  try { validatePolicy(parsed as WritePolicy); }
  catch (error) {
    throw new Error(`The policy file at ${path} is not a valid WritePolicy (${error instanceof ReceiptsError ? error.code : 'invalid_policy'}).`);
  }
  return parsed as WritePolicy;
}

function loadSigningKey(path: string): KeyObject {
  let pem: string;
  try { pem = readFileSync(path, 'utf8'); }
  catch { throw new Error(`The signing key file at ${path} could not be read.`); }
  let key: KeyObject;
  try { key = createPrivateKey(pem); }
  catch { throw new Error(`The signing key file at ${path} is not a PEM PKCS8 private key.`); }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`The signing key file at ${path} must contain an Ed25519 private key.`);
  }
  try {
    if (statSync(path).mode & 0o077) process.stderr.write(`Warning: the signing key file at ${path} is readable by other users; use mode 0600.\n`);
  } catch { /* Permission metadata is advisory; the key was already loaded. */ }
  return key;
}

function parseClaimTtl(value: string, source: string): number {
  if (!/^\d{1,15}$/.test(value) || Number(value) < 1) throw new Error(`${source} must be a positive integer number of milliseconds.`);
  return Number(value);
}

function configured(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function main(): Promise<void> {
  let transport = 'stdio';
  let port = 3100;
  let auditPath: string | undefined;
  let policyPath: string | undefined;
  let claimTtl: string | undefined;
  let signingKeyPath: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      return;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    if (arg === '--transport' && ['stdio', 'http'].includes(value)) transport = value;
    else if (arg === '--port' && /^\d+$/.test(value) && Number(value) > 0 && Number(value) < 65536) port = Number(value);
    else if (arg === '--audit-path') auditPath = value;
    else if (arg === '--policy') policyPath = value;
    else if (arg === '--claim-ttl') claimTtl = value;
    else if (arg === '--signing-key') signingKeyPath = value;
    else throw new Error(`Invalid option: ${arg} ${value}. Use --help.`);
  }
  policyPath ??= configured('RECEIPTS_POLICY_PATH');
  signingKeyPath ??= configured('RECEIPTS_SIGNING_KEY_PATH');
  const claimTtlMs = claimTtl !== undefined ? parseClaimTtl(claimTtl, '--claim-ttl')
    : configured('RECEIPTS_CLAIM_TTL_MS') !== undefined ? parseClaimTtl(configured('RECEIPTS_CLAIM_TTL_MS')!, 'RECEIPTS_CLAIM_TTL_MS') : undefined;
  const fileRoots = configured('RECEIPTS_FILE_ROOTS')?.split(delimiter).map(root => root.trim()).filter(Boolean);
  const options: ServerOptions = {
    connectors: configuredConnectors(),
    ...(fileRoots?.length ? { fileRoots } : {}),
    ...(auditPath ? {store:new JsonlAuditStore(auditPath)} : {}),
    ...(policyPath ? { policy: loadPolicy(policyPath) } : {}),
    ...(claimTtlMs !== undefined ? { claimTtlMs } : {}),
    ...(signingKeyPath ? { signingKey: loadSigningKey(signingKeyPath) } : {}),
  };
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
