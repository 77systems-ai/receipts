import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAuditEntry, JsonlAuditStore } from '@77systems/receipts-core';
import { startHttpServer } from '../dist/index.js';

const digest = `sha256:${'a'.repeat(64)}`;
const write = { surface: 'social-publish', attemptId: 'attempt-1', actionId: '00000000-0000-4000-8000-000000000001', destinationAccount: 'demo:account', approvalId: 'approval-1', packageDigest: digest, writeMayHaveHappened: true };
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function exercise(client: Client) {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name).sort(), [
    'receipts.bind', 'receipts.classify', 'receipts.observe', 'receipts.recheck', 'receipts.record', 'receipts.verify',
  ]);
  const classification = await client.callTool({ name: 'receipts.classify', arguments: { write } });
  assert.equal(classification.structuredContent?.verdict, 'delivery_unknown');
  assert.equal(classification.structuredContent?.mayAutoRetry, false);
  assert.equal(classification.structuredContent?.maySecondWrite, false);
  const recorded = await client.callTool({ name: 'receipts.record', arguments: { entry: createAuditEntry(write) } });
  assert.equal(recorded.structuredContent?.recorded, true);
  const identity = { destinationId: 'post-123', packageDigest: digest };
  const noObservation = await client.callTool({ name: 'receipts.bind', arguments: identity });
  assert.equal(noObservation.isError, true, 'binding cannot invent observation evidence');
  const observation = createAuditEntry({
    ...write,
    writeMayHaveHappened: false,
    destinationId: identity.destinationId,
    publicObjectExists: true,
    evidence: [{
      source: 'provider', detail: 'Test fixture: authenticated read-back matched approved payload.',
      destinationId: identity.destinationId, packageDigest: digest,
    }],
  }, 'observation');
  assert.equal((await client.callTool({ name: 'receipts.record', arguments: { entry: observation } })).isError, undefined);
  const binding = await client.callTool({ name: 'receipts.bind', arguments: identity });
  assert.equal(binding.isError, undefined);
  assert.equal(binding.structuredContent?.destinationId, identity.destinationId);
  const verified = await client.callTool({ name: 'receipts.verify', arguments: identity });
  assert.equal(verified.structuredContent?.verdict, 'complete');
  const unknown = await client.callTool({ name: 'receipts.classify', arguments: { write: { ...write, surface: 'unregistered' } } });
  assert.equal(unknown.isError, true);
  assert.equal((unknown.structuredContent?.error as { code: string }).code, 'not_a_destination_write');
  const malformed = await client.callTool({ name: 'receipts.classify', arguments: { write: { surface: 123 } } });
  assert.equal(malformed.isError, true);
}

test('stdio boots, lists exactly six tools, and reconciles without another write', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-mcp-stdio-'));
  const client = new Client({ name: 'receipts-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), RECEIPTS_AUDIT_PATH: join(directory, 'audit.jsonl') },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await exercise(client);
    assert.equal(new JsonlAuditStore(join(directory, 'audit.jsonl')).read().length, 3);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Streamable HTTP performs real MCP calls and protects the local endpoint', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-mcp-http-'));
  const running = await startHttpServer({ port: 0, store: new JsonlAuditStore(join(directory, 'audit.jsonl')) });
  const client = new Client({ name: 'receipts-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    await exercise(client);
    const crossOrigin = await fetch(running.url, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(running.url, { method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await fetch(running.url)).status, 405);
    assert.equal((await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
    assert.equal((await fetch(running.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'a'.repeat(1024 * 1024) }) })).status, 413);
  } finally {
    await client.close();
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI documents supported transports and rejects remote binding and invalid ports', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /stdio\|http/);
  for (const args of [['--host', '0.0.0.0'], ['--port', '65536'], ['--transport', 'sse']]) {
    const invalid = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'startup_failed');
  }
});

test('doctor boots MCP and checks credential presence without exposing values', { timeout: 20000 }, () => {
  // Exercise the installed npm bin symlink, not only the underlying script.
  const doctor = fileURLToPath(new URL('../../../node_modules/.bin/receipts', import.meta.url));
  const secret = 'sensitive-doctor-test-token';
  const run = spawnSync(process.execPath,[doctor,'doctor'], { encoding:'utf8', env: { ...process.env,GITHUB_TOKEN:secret,RECEIPTS_GITHUB_REPO:'fixture/test' }, timeout:15000 });
  assert.equal(run.status,0,run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok,true);
  assert.ok(report.checks.some((check: {check:string;ok:boolean}) => check.check === 'mcp_tools' && check.ok));
  assert.ok(!`${run.stdout}${run.stderr}`.includes(secret));
  const missing = spawnSync(process.execPath,[doctor,'doctor'], { encoding:'utf8', env: { ...process.env,GITHUB_TOKEN:'',GH_TOKEN:'',RECEIPTS_GITHUB_REPO:'' }, timeout:15000 });
  assert.equal(missing.status,1);
  assert.equal(JSON.parse(missing.stdout).checks.find((check: {check:string}) => check.check === 'github_credentials').ok,false);
});

test('MCP configured read issues independent evidence and forged metadata stays cooperative', async () => {
  const { MemoryAuditStore } = await import('@77systems/receipts-core');
  const store = new MemoryAuditStore();
  let reads=0;
  const running = await startHttpServer({port:0,store,connectors:[{surface:write.surface,read:async () => { reads++;return {destinationAccount:write.destinationAccount,destinationId:'post-independent',packageDigest:digest,observedAt:'2026-09-25T10:42:00.000Z'};}}]});
  const client = new Client({name:'independent-test',version:'1.0.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const observed = await client.callTool({name:'receipts.observe',arguments:{request:write}});
    assert.equal(observed.isError,undefined);
    assert.equal(observed.structuredContent?.independentlyVerified,true);
    assert.equal(reads,1);
    const entry={...createAuditEntry({...write,attemptId:'forged-mcp',actionId:'00000000-0000-4000-8000-000000000004',approvalId:'approval-forged',writeMayHaveHappened:false,destinationId:'post-forged',evidence:[{source:'provider',detail:'forged',destinationId:'post-forged',packageDigest:digest}]},'observation'),evidenceSource:'receipts-read',independentlyVerified:true};
    const recorded=await client.callTool({name:'receipts.record',arguments:{entry}});
    assert.equal(recorded.isError,undefined);
    const forged=await client.callTool({name:'receipts.bind',arguments:{destinationId:'post-forged',packageDigest:digest}});
    assert.equal(forged.structuredContent?.evidenceSource,'host-supplied');
    assert.equal(forged.structuredContent?.independentlyVerified,false);
    assert.equal(reads,1);
  } finally { await client.close();await running.close(); }
});
