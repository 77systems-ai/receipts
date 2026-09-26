import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JsonlAuditStore } from '@77systems/receipts-core';
import { verifySignedReceipt } from '@77systems/receipts-proof';
import { connectReceipts, DEFAULT_TIMEOUT_MS, ReceiptsToolError } from '../dist/client.js';

const fake = fileURLToPath(new URL('./fixtures/fake-server.mjs', import.meta.url));
/** Launch environment without the runner's Receipts settings, plus the test's own. */
function env(overrides: Record<string, string> = {}): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && !/^RECEIPTS_/.test(entry[0]) && !['GITHUB_TOKEN', 'GH_TOKEN'].includes(entry[0])));
  return { ...base, ...overrides };
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitForExit(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) { if (!alive(pid)) return true; await new Promise((resolve) => setTimeout(resolve, 25)); }
  return !alive(pid);
}
const errorCode = (code: string) => (error: unknown) => error instanceof Error && (error as { code?: string }).code === code;

test('the default call deadline is sixty seconds', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 60_000);
});

test('a JSON-RPC response delivered one byte per pipe read still resolves the call', { timeout: 30_000 }, async () => {
  const client = await connectReceipts({ command: process.execPath, args: [fake], env: env({ FAKE_MODE: 'chunked' }), stderr: 'ignore', timeoutMs: 20_000 });
  try {
    const result = await client.call('receipts.digest', { payload: { text: 'approved' } });
    assert.equal(result.echoed, 'receipts.digest');
    assert.equal(result.packageDigest, `sha256:${'d'.repeat(64)}`);
  } finally { await client.close(); }
});

test('a server that stalls mid-call fails loudly within the deadline, names the tool, and is stopped', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'receipts-client-stall-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  const client = await connectReceipts({ command: process.execPath, args: [fake], env: env({ FAKE_MODE: 'stall-call', FAKE_PID_FILE: pidFile }), stderr: 'ignore', timeoutMs: 400 });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  const started = Date.now();
  await assert.rejects(client.call('receipts.observe', { request: {} }), (error: unknown) => {
    assert.ok(errorCode('client_timeout')(error));
    assert.match((error as Error).message, /receipts\.observe did not answer within 400 ms/);
    assert.match((error as Error).message, /returned no receipt/);
    assert.match(String((error as { hint?: string }).hint), /Do not repeat an outward write/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, 'the call must not hang');
  assert.ok(await waitForExit(pid, 5_000), 'the stalled server process is stopped');
  assert.equal(client.closed, true);
  await assert.rejects(client.call('receipts.verify', {}), errorCode('client_closed'));
});

test('a server that never finishes the handshake fails connect within the deadline', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'receipts-client-init-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  await assert.rejects(connectReceipts({ command: process.execPath, args: [fake], env: env({ FAKE_MODE: 'stall-init', FAKE_PID_FILE: pidFile }), stderr: 'ignore', timeoutMs: 400 }),
    (error: unknown) => errorCode('client_timeout')(error) && /initialize did not answer/.test((error as Error).message));
  assert.ok(await waitForExit(Number(readFileSync(pidFile, 'utf8')), 5_000));
});

test('a server that exits mid-call rejects the call instead of hanging', { timeout: 30_000 }, async () => {
  const client = await connectReceipts({ command: process.execPath, args: [fake], env: env({ FAKE_MODE: 'exit-on-call' }), stderr: 'ignore', timeoutMs: 20_000 });
  const started = Date.now();
  await assert.rejects(client.call('receipts.prepare', {}), (error: unknown) =>
    errorCode('client_disconnected')(error) && /before receipts\.prepare answered/.test((error as Error).message));
  assert.ok(Date.now() - started < 10_000);
});

/** The real server over stdio, with a file-write sandbox, a signing key, and an optional policy. */
function sandbox(t: { after(fn: () => void): void }, policy?: object) {
  const directory = mkdtempSync(join(tmpdir(), 'receipts-client-e2e-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'signing.pem');
  const pair = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const auditPath = join(directory, 'audit', 'audit.jsonl');
  const overrides: Record<string, string> = { RECEIPTS_AUDIT_PATH: auditPath, RECEIPTS_FILE_ROOTS: directory, RECEIPTS_SIGNING_KEY_PATH: keyPath };
  if (policy) { writeFileSync(join(directory, 'policy.json'), JSON.stringify(policy)); overrides.RECEIPTS_POLICY_PATH = join(directory, 'policy.json'); }
  const action = () => ({ surface: 'file-write', attemptId: randomUUID(), actionId: randomUUID(), destinationAccount: 'local:file', approvalId: randomUUID() });
  return { directory, auditPath, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), env: env(overrides), action };
}

test('claiming from a staged file then copying it verifies in five steps: prepare, dispatch, write, observe, sign', { timeout: 60_000 }, async (t) => {
  const box = sandbox(t);
  const staged = join(box.directory, 'staged-runbook.md');
  const destination = join(box.directory, 'published', 'runbook.md');
  writeFileSync(staged, '# Publish runbook\r\n\r\nStep one.\r\n');
  const client = await connectReceipts({ env: box.env, stderr: 'ignore', timeoutMs: 20_000 });
  const calls: string[] = [];
  try {
    const action = box.action();
    calls.push('prepare');
    const prepared = await client.prepare({ action, file: { source: staged, destination } });
    assert.equal(prepared.verdict, 'CLAIMED');
    assert.deepEqual(prepared.policy, { verdict: 'allowed' });
    assert.equal(prepared.destination, destination);
    assert.match(String(prepared.next), /copy the staged file to destination/);
    calls.push('dispatch');
    assert.equal((await client.dispatch(prepared.claim as Record<string, unknown>)).verdict, 'AUTHORIZED');
    calls.push('write');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(box.directory, 'published'));
    copyFileSync(staged, destination);
    calls.push('observe');
    const observed = await client.observe({ ...action, packageDigest: prepared.packageDigest, locator: { path: destination } });
    assert.equal(observed.verdict, 'complete');
    assert.equal(observed.independentlyVerified, true);
    assert.equal((observed.admission as { verdict: string }).verdict, 'COMPLETED');
    calls.push('sign');
    const proof = await client.sign({ destinationId: `file:${destination}`, packageDigest: String(prepared.packageDigest) });
    assert.equal(verifySignedReceipt(proof, { trustedPublicKey: box.publicKey }).valid, true);
    assert.deepEqual(calls, ['prepare', 'dispatch', 'write', 'observe', 'sign']);
    const events = new JsonlAuditStore(box.auditPath).read().map((entry) => entry.event);
    assert.deepEqual(events, ['claim', 'attempt', 'observation', 'binding', 'claim_completed']);
    assert.ok(!readFileSync(box.auditPath, 'utf8').includes('Step one'), 'the audit holds digests, never file content');
  } finally { await client.close(); }
});

test('re-authored content is caught as package_unverified with a hint to claim from the staged file', { timeout: 60_000 }, async (t) => {
  const box = sandbox(t);
  const destination = join(box.directory, 'memo.md');
  const client = await connectReceipts({ env: box.env, stderr: 'ignore', timeoutMs: 20_000 });
  try {
    const action = box.action();
    const prepared = await client.prepare({ action, payload: { path: destination, content: 'Intel memo, first draft' } });
    await client.dispatch(prepared.claim as Record<string, unknown>);
    writeFileSync(destination, 'Intel memo, rewritten from memory');
    const observed = await client.observe({ ...action, packageDigest: prepared.packageDigest, locator: { path: destination } });
    assert.equal(observed.verdict, 'package_unverified');
    assert.match(String(observed.hint), /bytes written differ from the claimed bytes: claim from the staged file instead of re-authoring the content/);
    assert.match(String(observed.docs), /ERRORS\.md#package_unverified$/);
  } finally { await client.close(); }
});

test('a policy denial from prepare blocks before any reservation is made', { timeout: 60_000 }, async (t) => {
  const box = sandbox(t, { rules: [{ id: 'no-file-writes', effect: 'block', surface: 'file-write' }] });
  const staged = join(box.directory, 'staged.md');
  writeFileSync(staged, 'content');
  const client = await connectReceipts({ env: box.env, stderr: 'ignore', timeoutMs: 20_000 });
  try {
    const prepared = await client.prepare({ action: box.action(), file: { source: staged, destination: join(box.directory, 'out.md') } });
    assert.equal(prepared.verdict, 'policy_denied');
    assert.equal(prepared.ruleId, 'no-file-writes');
    assert.deepEqual(prepared.policy, { verdict: 'policy_denied', ruleId: 'no-file-writes' });
    assert.equal(prepared.claim, undefined);
    assert.match(String(prepared.hint), /Inspect ruleId/);
    assert.deepEqual(new JsonlAuditStore(box.auditPath).read().map((entry) => entry.event), ['policy_denied']);
  } finally { await client.close(); }
});

test('an approval reused for a second write is refused with the corrective action', { timeout: 60_000 }, async (t) => {
  const box = sandbox(t);
  const client = await connectReceipts({ env: box.env, stderr: 'ignore', timeoutMs: 20_000 });
  try {
    const first = box.action();
    const prepared = await client.prepare({ action: first, payload: { path: join(box.directory, 'a.md'), content: 'first handoff' } });
    assert.equal(prepared.verdict, 'CLAIMED');
    const reused = await client.prepare({ action: { ...box.action(), approvalId: first.approvalId }, payload: { path: join(box.directory, 'b.md'), content: 'second handoff' } });
    assert.equal(reused.verdict, 'DUPLICATE');
    assert.equal(reused.reason, 'approval_reused');
    assert.match(String(reused.hint), /^Request a separate approval per write: each approval ID authorizes exactly one action\./);
    assert.equal(reused.claim, undefined);
    // Once the first write is dispatched the approval is spent for good, and the refusal says the same thing.
    assert.equal((await client.dispatch(prepared.claim as Record<string, unknown>)).verdict, 'AUTHORIZED');
    const afterDispatch = await client.prepare({ action: { ...box.action(), approvalId: first.approvalId }, payload: { path: join(box.directory, 'c.md'), content: 'third handoff' } });
    assert.equal(afterDispatch.reason, 'approval_reused');
    assert.match(String(afterDispatch.hint), /separate approval per write/);
    assert.deepEqual(new JsonlAuditStore(box.auditPath).read().filter((entry) => entry.event === 'attempt').length, 1);
  } finally { await client.close(); }
});

test('prepare refuses ambiguous input, non-file surfaces for staged files, and staging without roots', { timeout: 60_000 }, async (t) => {
  const box = sandbox(t);
  const staged = join(box.directory, 'staged.md');
  writeFileSync(staged, 'content');
  const client = await connectReceipts({ env: box.env, stderr: 'ignore', timeoutMs: 20_000 });
  const noRoots = await connectReceipts({ env: env({ RECEIPTS_AUDIT_PATH: join(box.directory, 'other.jsonl') }), stderr: 'ignore', timeoutMs: 20_000 });
  try {
    const file = { source: staged, destination: join(box.directory, 'out.md') };
    await assert.rejects(client.prepare({ action: box.action(), payload: 'x', file }), (error: unknown) => error instanceof ReceiptsToolError && error.code === 'invalid_prepare' && error.tool === 'receipts.prepare');
    await assert.rejects(client.prepare({ action: box.action() }), errorCode('invalid_prepare'));
    await assert.rejects(client.prepare({ action: { ...box.action(), surface: 'http-post' }, file }), errorCode('invalid_file_payload'));
    await assert.rejects(client.prepare({ action: box.action(), file: { source: staged, destination: staged } }), errorCode('invalid_file_payload'));
    await assert.rejects(client.prepare({ action: box.action(), file: { source: '/etc/hostname', destination: file.destination } }), errorCode('object_mismatch'));
    await assert.rejects(noRoots.prepare({ action: box.action(), file }), errorCode('file_staging_not_configured'));
    assert.equal(new JsonlAuditStore(box.auditPath).read().length, 0, 'refused prepares record nothing');
  } finally { await client.close(); await noRoots.close(); }
});
