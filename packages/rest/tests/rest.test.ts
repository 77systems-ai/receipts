import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAuditEntry, JsonlAuditStore } from '@77systems/receipts-core';
import { createReceiptsApp, startRestServer } from '../dist/index.js';

const digest = `sha256:${'b'.repeat(64)}`;
const write = { surface: 'http-post', attemptId: 'attempt-rest-1', actionId: '00000000-0000-4000-8000-000000000002', destinationAccount: 'demo:account', approvalId: 'approval-1', packageDigest: digest, writeMayHaveHappened: true };

test('REST records uncertainty, binds a real observation, and verifies the durable receipt', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-rest-'));
  const store = new JsonlAuditStore(join(directory, 'audit.jsonl'));
  const running = await startRestServer({ port: 0, store });
  const post = (path: string, value: unknown) => fetch(`${running.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const classification = await (await post('/classify', write)).json();
    assert.equal(classification.verdict, 'delivery_unknown');
    assert.equal(classification.mayAutoRetry, false);
    assert.equal(classification.maySecondWrite, false);
    assert.equal((await post('/record', createAuditEntry(write))).status, 201);
    const identity = { destinationId: 'object-1', packageDigest: digest };
    assert.equal((await post('/bind', identity)).status, 400);
    const observation = createAuditEntry({
      ...write, writeMayHaveHappened: false, destinationId: identity.destinationId, publicObjectExists: true,
      evidence: [{ source: 'human', detail: 'Test fixture: operator supplied ID and confirmed the approved package.', ...identity }],
    }, 'observation');
    assert.equal((await post('/record', observation)).status, 201);
    const binding = await post('/bind', identity);
    assert.equal(binding.status, 200);
    assert.equal((await binding.json()).destinationId, identity.destinationId);
    const verified = await fetch(`${running.url}/verify?${new URLSearchParams(identity)}`);
    const receipt = await verified.json();
    assert.equal(receipt.verdict,'complete');
    assert.equal(receipt.evidenceSource,'host-supplied');
    assert.equal(receipt.independentlyVerified,false);
    assert.ok(receipt.observedAt);
    assert.equal(store.read().length, 3);
    assert.equal(store.read()[0]?.verdict, 'delivery_unknown', 'earlier uncertainty remains in append-only history');
  } finally {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('REST rejects malformed requests, unknown surfaces, foreign origins, and oversized bodies', async () => {
  const app = createReceiptsApp();
  const request = (body: unknown, headers = {}) => app.request('http://localhost/classify', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const missing = await request({ surface: 'http-post' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'invalid_input');
  assert.equal((await request(null)).status, 400);
  const unknown = await request({ ...write, surface: 'not-registered' });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'not_a_destination_write');
  assert.equal((await request(write, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request(write, { host: 'attacker.example' })).status, 403);
  assert.equal((await request(write, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request({ ...write, statusFlag: 'a'.repeat(1024 * 1024) })).status, 413);
  assert.equal((await app.request('http://localhost/classify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await app.request('http://localhost/verify')).status, 400);
});

test('REST CLI rejects non-loopback binding options and invalid ports', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  assert.equal(spawnSync(process.execPath, [cli, '--help']).status, 0);
  for (const args of [['--host', '0.0.0.0'], ['--port', '0']]) {
    const invalid = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'startup_failed');
  }
});

test('REST only the configured connector can issue independent provenance', async () => {
  const { MemoryAuditStore } = await import('@77systems/receipts-core');
  const store = new MemoryAuditStore();
  let reads = 0;
  let currentDigest = digest;
  const connector = { surface:'http-post', async read() { reads++; return { destinationAccount:write.destinationAccount, destinationId:'object-independent', packageDigest:currentDigest, observedAt:new Date().toISOString() }; } };
  const app = createReceiptsApp({store,connectors:[connector]});
  const post = (path: string, body: unknown) => app.request(`http://localhost${path}`,{ method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  const forged = {...createAuditEntry({...write,destinationId:'object-forged',writeMayHaveHappened:false,evidence:[{source:'provider',detail:'private body do not retain',destinationId:'object-forged',packageDigest:digest}]},'observation'),evidenceSource:'receipts-read',independentlyVerified:true};
  assert.equal((await post('/record',forged)).status,201);
  const cooperative = await (await post('/bind',{destinationId:'object-forged',packageDigest:digest})).json();
  assert.equal(cooperative.independentlyVerified,false);
  assert.equal(reads,0);
  assert.ok(!JSON.stringify(store.read()).includes('private body do not retain'));
  const request = {...write,attemptId:'attempt-independent',actionId:'00000000-0000-4000-8000-000000000003',approvalId:'approval-independent'};
  const independent = await (await post('/observe',request)).json();
  assert.equal(independent.verdict,'complete');
  assert.equal(independent.independentlyVerified,true);
  assert.equal(independent.evidenceSource,'receipts-read');
  assert.equal(reads,1);
  const before=JSON.stringify(store.read());
  currentDigest=`sha256:${'c'.repeat(64)}`;
  const changed = await (await post('/recheck',{...request,destinationId:'object-independent'})).json();
  assert.equal(changed.verdict,'package_unverified');
  assert.equal(changed.independentlyVerified,true);
  const historic=await (await app.request(`http://localhost/verify?${new URLSearchParams({destinationId:'object-independent',packageDigest:digest})}`)).json();
  assert.equal(historic.observedAt,independent.observedAt);
  assert.equal(historic.verdict,'complete');
  assert.equal(JSON.stringify(store.read().slice(0,-1)),before);
  assert.equal((await post('/observe',{...request,locator:{issueNumber:{token:'secret'}}})).status,400);
});
