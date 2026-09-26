import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAuditEntry, JsonlAuditStore, MemoryAuditStore, type ApprovedAction, type ClaimLease } from '@77systems/receipts-core';
import { digestPayload } from '@77systems/receipts-sdk';
import { generateReceiptKeyPair, verifySignedReceipt } from '@77systems/receipts-proof';
import { createReceiptsServer, startHttpServer } from '../dist/index.js';

const MCP_VERSION = (JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

/** Child processes start from the runner's environment minus every Receipts setting, so a developer's exports cannot change behavior under test. */
function childEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && !/^RECEIPTS_/.test(entry[0]) && !['GITHUB_TOKEN', 'GH_TOKEN'].includes(entry[0])));
  return { ...base, ...overrides };
}
const digest = `sha256:${'a'.repeat(64)}`;
const write = { surface: 'social-publish', attemptId: 'attempt-1', actionId: '00000000-0000-4000-8000-000000000001', destinationAccount: 'demo:account', approvalId: 'approval-1', packageDigest: digest, writeMayHaveHappened: true };
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const approvedPayload = { title: 'Approved title', body: 'Exact approved body' };
const approvedDigest = digestPayload(approvedPayload);
const TOOL_NAMES = [
  'receipts.badge', 'receipts.bind', 'receipts.claim', 'receipts.classify', 'receipts.complete', 'receipts.digest', 'receipts.dispatch',
  'receipts.observe', 'receipts.policy', 'receipts.recheck', 'receipts.record', 'receipts.release', 'receipts.sign', 'receipts.verify',
];
type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function nextAction(overrides: Partial<ApprovedAction> = {}): ApprovedAction {
  return { surface: write.surface, attemptId: randomUUID(), actionId: randomUUID(), destinationAccount: write.destinationAccount,
    approvalId: randomUUID(), packageDigest: approvedDigest, ...overrides };
}
function code(response: ToolResult): string | undefined {
  return (response.structuredContent?.error as { code?: string } | undefined)?.code;
}
const errorCode = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
function observationEntry(action: ApprovedAction, destinationId: string, source: 'provider' | 'human' = 'human') {
  return createAuditEntry({ ...action, destinationId, publicObjectExists: true, writeMayHaveHappened: false,
    evidence: [{ source, detail: 'Test fixture: authenticated read-back matched approved payload.', destinationId, packageDigest: action.packageDigest }] }, 'observation');
}
async function claimLease(client: Client, action: ApprovedAction): Promise<ClaimLease> {
  const claimed = await client.callTool({ name: 'receipts.claim', arguments: { action } });
  assert.equal(claimed.isError, undefined, JSON.stringify(claimed.structuredContent));
  assert.equal(claimed.structuredContent?.verdict, 'CLAIMED');
  const claim = claimed.structuredContent?.claim as ClaimLease;
  assert.match(claim.token, /^[0-9a-f]{64}$/, 'the lease token is returned only to the caller');
  assert.equal(claim.actionId, action.actionId);
  return claim;
}

async function exercise(client: Client) {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name).sort(), TOOL_NAMES);
  assert.ok(listed.tools.every((tool) => typeof tool.title === 'string' && tool.title.length > 0), 'every tool carries a short title');
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
  // The digest of the exact approved payload is computed once; the content itself never appears in a result.
  const digested = await client.callTool({ name: 'receipts.digest', arguments: { payload: approvedPayload } });
  assert.equal(digested.isError, undefined);
  assert.equal(digested.structuredContent?.packageDigest, approvedDigest);
  assert.equal(digested.structuredContent?.encoding, 'receipts-json-v1');
  assert.ok(!JSON.stringify(digested).includes(approvedPayload.body));
  const evaluated = await client.callTool({ name: 'receipts.policy', arguments: { action: nextAction() } });
  assert.deepEqual(evaluated.structuredContent, { verdict: 'allowed', policyConfigured: false });
}

/** Cooperative guarded write over a real MCP client. Returns the lease token so callers can prove it was never persisted. */
async function guardedCooperativeWrite(client: Client): Promise<string> {
  const action = nextAction();
  const destinationId = `post-${action.attemptId}`;
  const claim = await claimLease(client, action);
  assert.equal(claim.fence, 1);
  const early = await client.callTool({ name: 'receipts.complete', arguments: { action, destinationId } });
  assert.equal(code(early), 'claim_not_dispatched', 'completion needs a durable dispatch first');
  const forged = await client.callTool({ name: 'receipts.dispatch', arguments: { claim: { ...claim, token: 'f'.repeat(64) } } });
  assert.equal(forged.isError, true);
  assert.equal(code(forged), 'stale_claim', 'a forged token cannot dispatch');
  const dispatched = await client.callTool({ name: 'receipts.dispatch', arguments: { claim } });
  assert.equal(dispatched.isError, undefined, JSON.stringify(dispatched.structuredContent));
  assert.equal(dispatched.structuredContent?.verdict, 'AUTHORIZED');
  const twice = await client.callTool({ name: 'receipts.dispatch', arguments: { claim } });
  assert.equal(code(twice), 'claim_dispatched', 'the same claim never dispatches twice');
  const unbound = await client.callTool({ name: 'receipts.complete', arguments: { action, destinationId } });
  assert.equal(code(unbound), 'observation_required', 'completion needs an audited binding');
  assert.equal((await client.callTool({ name: 'receipts.record', arguments: { entry: observationEntry(action, destinationId) } })).isError, undefined);
  const bound = await client.callTool({ name: 'receipts.bind', arguments: { destinationId, packageDigest: action.packageDigest, scope: { actionId: action.actionId, destinationAccount: action.destinationAccount } } });
  assert.equal(bound.isError, undefined);
  assert.equal(bound.structuredContent?.independentlyVerified, false);
  const completed = await client.callTool({ name: 'receipts.complete', arguments: { action, destinationId } });
  assert.equal(completed.isError, undefined, JSON.stringify(completed.structuredContent));
  assert.equal(completed.structuredContent?.verdict, 'COMPLETED');
  const again = await client.callTool({ name: 'receipts.complete', arguments: { action, destinationId } });
  assert.equal(again.structuredContent?.verdict, 'COMPLETED', 'completion is idempotent without a token');
  const duplicate = await client.callTool({ name: 'receipts.claim', arguments: { action: { ...action, attemptId: randomUUID() } } });
  assert.equal(duplicate.structuredContent?.verdict, 'DUPLICATE');
  assert.equal(duplicate.structuredContent?.reason, 'completed');
  const released = await client.callTool({ name: 'receipts.release', arguments: { claim } });
  assert.equal(code(released), 'claim_dispatched', 'a dispatched claim is never released');
  return claim.token;
}

test('stdio boots, lists exactly fourteen tools, and reconciles a guarded write without another write', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-mcp-stdio-'));
  const client = new Client({ name: 'receipts-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli],
    env: { ...childEnv(), RECEIPTS_AUDIT_PATH: join(directory, 'audit.jsonl') },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await exercise(client);
    assert.equal(new JsonlAuditStore(join(directory, 'audit.jsonl')).read().length, 3);
    const token = await guardedCooperativeWrite(client);
    const entries = new JsonlAuditStore(join(directory, 'audit.jsonl')).read();
    assert.deepEqual(entries.slice(3).map((entry) => entry.event), ['claim', 'attempt', 'observation', 'binding', 'claim_completed', 'duplicate']);
    assert.equal(entries.filter((entry) => entry.event === 'attempt').length, 1);
    const persisted = await readFile(join(directory, 'audit.jsonl'), 'utf8');
    assert.ok(!persisted.includes(token), 'the lease token is only hashed in the audit');
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
    const token = await guardedCooperativeWrite(client);
    assert.ok(!(await readFile(join(directory, 'audit.jsonl'), 'utf8')).includes(token));
    const unsigned = await client.callTool({ name: 'receipts.sign', arguments: { destinationId: 'post-123', packageDigest: digest } });
    assert.equal(unsigned.isError, true);
    assert.equal(code(unsigned), 'signing_key_not_configured', 'signing is opt-in');
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
  for (const flag of ['--policy FILE', '--claim-ttl MS', '--signing-key FILE', 'RECEIPTS_POLICY_PATH', 'RECEIPTS_CLAIM_TTL_MS', 'RECEIPTS_SIGNING_KEY_PATH']) {
    assert.ok(help.stdout.includes(flag), `help mentions ${flag}`);
  }
  for (const args of [['--host', '0.0.0.0'], ['--port', '65536'], ['--transport', 'sse']]) {
    const invalid = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'startup_failed');
  }
});

test('CLI fails closed on invalid policy, signing key, and TTL configuration without echoing file contents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-cli-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const brokenPolicy = join(directory, 'broken.json');
  await writeFile(brokenPolicy, '{ not json POLICY-FILE-SECRET-TEXT');
  const unknownSurface = join(directory, 'surface.json');
  await writeFile(unknownSurface, JSON.stringify({ rules: [{ id: 'r', effect: 'block', surface: 'unregistered-surface-name' }] }));
  const notAKey = join(directory, 'not-a-key.pem');
  await writeFile(notAKey, 'KEY-FILE-SECRET-TEXT');
  const wrongKeyType = join(directory, 'x25519.pem');
  await writeFile(wrongKeyType, generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const cases: Array<[string[], string | undefined]> = [
    [['--policy', brokenPolicy], 'POLICY-FILE-SECRET-TEXT'],
    [['--policy', join(directory, 'missing.json')], undefined],
    [['--policy', unknownSurface], 'unregistered-surface-name'],
    [['--signing-key', join(directory, 'missing.pem')], undefined],
    [['--signing-key', notAKey], 'KEY-FILE-SECRET-TEXT'],
    [['--signing-key', wrongKeyType], 'PRIVATE KEY'],
    [['--claim-ttl', '0'], undefined],
    [['--claim-ttl', 'soon'], undefined],
    [['--claim-ttl', String(31 * 24 * 60 * 60 * 1000)], undefined],
  ];
  for (const [args, secret] of cases) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 1, args.join(' '));
    assert.equal(JSON.parse(run.stderr).error.code, 'startup_failed', args.join(' '));
    assert.equal(run.stdout, '', 'stdout stays reserved for MCP');
    if (secret) assert.ok(!run.stderr.includes(secret), `${args.join(' ')} must not echo file contents`);
  }
  const base = childEnv();
  for (const env of [{ RECEIPTS_POLICY_PATH: brokenPolicy }, { RECEIPTS_SIGNING_KEY_PATH: notAKey }, { RECEIPTS_CLAIM_TTL_MS: '-1' }]) {
    const run = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: { ...base, ...env }, timeout: 15000 });
    assert.equal(run.status, 1, JSON.stringify(env));
    assert.equal(JSON.parse(run.stderr).error.code, 'startup_failed');
    assert.ok(!run.stderr.includes('SECRET-TEXT'));
  }
});

test('CLI refuses to start a file connector without allowed roots or a half-configured Gmail connector', () => {
  for (const [env, message] of [
    [{ RECEIPTS_FILE_ACCOUNT: 'local:file' }, /RECEIPTS_FILE_ROOTS is required/],
    [{ RECEIPTS_GMAIL_TOKEN: 'gmail-token-must-not-echo' }, /RECEIPTS_GMAIL_ACCOUNT is required/],
    [{ RECEIPTS_GMAIL_ACCOUNT: 'me@example.com' }, /RECEIPTS_GMAIL_TOKEN is required/],
    [{ RECEIPTS_FILE_ROOTS: 'relative/root' }, /invalid_file_roots|absolute/],
  ] as const) {
    const run = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: childEnv(env), timeout: 15000, input: '' });
    assert.equal(run.status, 1);
    const error = JSON.parse(run.stderr.trim().split('\n').at(-1)!).error;
    assert.equal(error.code, 'startup_failed');
    assert.match(error.message, message);
    assert.ok(!run.stderr.includes('gmail-token-must-not-echo'));
  }
});

test('doctor boots through an executable link and checks credentials without exposing values', { timeout: 20000 }, async t => {
  // npm ci runs before dist exists in a fresh source checkout, so it need not
  // create workspace bin links. Reproduce the installed package's link explicitly.
  const directory = await mkdtemp(join(tmpdir(), 'receipts-doctor-bin-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const doctor = join(directory,'receipts');
  await symlink(fileURLToPath(new URL('../dist/receipts.js', import.meta.url)),doctor);
  const secret = 'sensitive-doctor-test-token';
  const configured = { ...childEnv(),GITHUB_TOKEN:secret,RECEIPTS_GITHUB_REPO:'fixture/test' };
  const run = spawnSync(process.execPath,[doctor,'doctor','--json'], { encoding:'utf8', env: configured, timeout:15000 });
  assert.equal(run.status,0,run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok,true);
  assert.equal(report.version,MCP_VERSION);
  assert.ok(report.checks.every((check: {name:unknown;ok:unknown;detail:unknown}) => typeof check.name === 'string' && typeof check.ok === 'boolean' && typeof check.detail === 'string'));
  assert.ok(report.checks.some((check: {name:string;ok:boolean}) => check.name === 'mcp_tools' && check.ok));
  assert.ok(!`${run.stdout}${run.stderr}`.includes(secret));
  // The default rendering is for people; --json is the machine-readable contract and stdout carries nothing else.
  const human = spawnSync(process.execPath,[doctor,'doctor'], { encoding:'utf8', env: configured, timeout:15000 });
  assert.equal(human.status,0,human.stderr);
  assert.ok(human.stdout.includes(`receipts doctor (@77systems/receipts-mcp ${MCP_VERSION})`));
  assert.match(human.stdout,/ok {2,}mcp_tools/);
  assert.match(human.stdout,/Result: ok/);
  assert.throws(() => JSON.parse(human.stdout));
  assert.ok(!human.stdout.includes(secret));
  const missing = spawnSync(process.execPath,[doctor,'doctor','--json'], { encoding:'utf8', env: { ...childEnv(),GITHUB_TOKEN:'',GH_TOKEN:'',RECEIPTS_GITHUB_REPO:'' }, timeout:15000 });
  assert.equal(missing.status,1);
  assert.equal(JSON.parse(missing.stdout).checks.find((check: {name:string}) => check.name === 'github_credentials').ok,false);
  assert.match(spawnSync(process.execPath,[doctor,'doctor'], { encoding:'utf8', env: { ...childEnv(),GITHUB_TOKEN:'',GH_TOKEN:'',RECEIPTS_GITHUB_REPO:'' }, timeout:15000 }).stdout,/FAIL {2}github_credentials/);
  for (const args of [[], ['nonsense'], ['doctor','--verbose']]) {
    const bad = spawnSync(process.execPath,[doctor,...args], { encoding:'utf8', env: configured, timeout:15000 });
    assert.equal(bad.status,1);
    assert.match(`${bad.stdout}${bad.stderr}`,/Usage:/);
  }
});

test('bug-report assembles a redacted support bundle and never emits values, identifiers, digests, or paths', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-bug-report-private-segment-7f3a-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const receipts = join(directory,'receipts');
  await symlink(fileURLToPath(new URL('../dist/receipts.js', import.meta.url)),receipts);
  const auditPath = join(directory,'audit.jsonl');
  const store = new JsonlAuditStore(auditPath);
  const privateAccount = 'social:very-private-account-91ac';
  const actionId = '00000000-0000-4000-8000-00000000c0de';
  const privateDigest = `sha256:${'c'.repeat(64)}`;
  store.append(createAuditEntry({ surface: 'social-publish', attemptId: 'private-attempt-55', actionId, destinationAccount: privateAccount, approvalId: 'private-approval-77', packageDigest: privateDigest, writeMayHaveHappened: true }, 'attempt'));
  const secrets = ['bug-report-secret-token-3e1', 'secretowner/secretrepo', 'private-segment-7f3a', privateAccount, actionId, privateDigest, 'private-attempt-55', 'private-approval-77', '/policy/private-policy.json', '/keys/private-signing-key.pem', 'ya29.gmail-secret-token-9d2'];
  const env = { ...childEnv(), GITHUB_TOKEN: secrets[0]!, GH_TOKEN: '', RECEIPTS_GITHUB_REPO: secrets[1]!, RECEIPTS_AUDIT_PATH: auditPath,
    RECEIPTS_POLICY_PATH: secrets[8]!, RECEIPTS_SIGNING_KEY_PATH: secrets[9]!, RECEIPTS_CLAIM_TTL_MS: '', RECEIPTS_HOOK_TOOLS: '', RECEIPTS_GMAIL_TOKEN: secrets[10]! };
  const run = spawnSync(process.execPath,[receipts,'bug-report','--json','--no-doctor','--tail','5'], { encoding:'utf8', env, timeout:20000 });
  assert.equal(run.status,0,run.stderr);
  const report = JSON.parse(run.stdout);
  for (const secret of secrets) assert.ok(!`${run.stdout}${run.stderr}`.includes(secret), `bundle leaked ${secret}`);
  assert.ok(report.title.startsWith(`Bug report: @77systems/receipts-mcp ${MCP_VERSION} (`));
  for (const heading of ['## Summary','## Steps to reproduce','## Environment','## Packages','## Configuration','## Doctor','## Audit health']) assert.ok(report.body.includes(heading), heading);
  assert.equal(report.bundle.configuration.GITHUB_TOKEN,'present');
  assert.equal(report.bundle.configuration.GH_TOKEN,'absent');
  assert.equal(report.bundle.configuration.RECEIPTS_POLICY_PATH,'present');
  assert.equal(report.bundle.configuration.RECEIPTS_CLAIM_TTL_MS,'absent');
  assert.equal(report.bundle.configuration.RECEIPTS_GMAIL_TOKEN,'present');
  assert.equal(report.bundle.configuration.RECEIPTS_FILE_ROOTS,'absent');
  assert.equal(report.bundle.packages['@77systems/receipts-mcp'],MCP_VERSION);
  assert.equal(report.bundle.doctor,null);
  assert.deepEqual({ ...report.bundle.audit, tail: undefined }, { location:'environment', exists:true, entries:1, headCheckpoint:true, chain:'valid', tail:undefined });
  assert.deepEqual(report.bundle.audit.tail.map((entry: {event:string;verdict:string;surface:string;admission:string|null}) => [entry.event, entry.verdict, entry.surface, entry.admission]), [['attempt','delivery_unknown','social-publish',null]]);
  assert.deepEqual(Object.keys(report.bundle.audit.tail[0]).sort(), ['admission','event','evidenceSource','sequence','surface','timestamp','verdict']);
  assert.ok(report.url.startsWith('https://github.com/77systems-ai/receipts/issues/new?title='));
  assert.equal(report.truncated,false);
  assert.equal(decodeURIComponent(new URL(report.url).searchParams.get('body')!), report.body);
  // Markdown by default with the link offered on stderr; --url prints only the link; --tail 0 drops the shape table.
  const markdown = spawnSync(process.execPath,[receipts,'bug-report','--no-doctor'], { encoding:'utf8', env, timeout:20000 });
  assert.equal(markdown.status,0);
  assert.match(markdown.stdout,/^## Summary/);
  assert.match(markdown.stderr,/--open/);
  assert.match(markdown.stderr,/Nothing has been sent/);
  const url = spawnSync(process.execPath,[receipts,'bug-report','--url','--no-doctor'], { encoding:'utf8', env, timeout:20000 });
  assert.equal(url.stdout.trim().split('\n').length,1);
  assert.ok(url.stdout.startsWith('https://github.com/77systems-ai/receipts/issues/new?'));
  const noTail = JSON.parse(spawnSync(process.execPath,[receipts,'bug-report','--json','--no-doctor','--tail','0','--audit-path',auditPath], { encoding:'utf8', env: { ...env, RECEIPTS_AUDIT_PATH: '' }, timeout:20000 }).stdout);
  assert.equal(noTail.bundle.audit.location,'flag');
  assert.deepEqual(noTail.bundle.audit.tail,[]);
  assert.ok(!noTail.body.includes('| # |'));
  // A corrupt or unregistered audit is reported by code, never by content.
  await writeFile(auditPath, (await readFile(auditPath,'utf8')).replace('delivery_unknown','complete'));
  const corrupt = JSON.parse(spawnSync(process.execPath,[receipts,'bug-report','--json','--no-doctor'], { encoding:'utf8', env, timeout:20000 }).stdout);
  assert.equal(corrupt.bundle.audit.chain,'audit_corrupt');
  assert.equal(corrupt.bundle.audit.entries,1);
  for (const secret of secrets) assert.ok(!JSON.stringify(corrupt).includes(secret));
  const absent = JSON.parse(spawnSync(process.execPath,[receipts,'bug-report','--json','--no-doctor'], { encoding:'utf8', env: { ...env, RECEIPTS_AUDIT_PATH: join(directory,'nowhere.jsonl') }, timeout:20000 }).stdout);
  assert.deepEqual({ exists: absent.bundle.audit.exists, chain: absent.bundle.audit.chain, entries: absent.bundle.audit.entries }, { exists:false, chain:'absent', entries:null });
  // With the doctor included, the bundle embeds the same machine-readable checks.
  // The doctor boots the real server, so the bogus policy and key paths above would (correctly) fail startup; clear them here.
  const full = JSON.parse(spawnSync(process.execPath,[receipts,'bug-report','--json'], { encoding:'utf8', env: { ...env, RECEIPTS_AUDIT_PATH: auditPath, RECEIPTS_POLICY_PATH: '', RECEIPTS_SIGNING_KEY_PATH: '', RECEIPTS_GMAIL_TOKEN: '' }, timeout:25000 }).stdout);
  assert.ok(full.bundle.doctor.checks.some((check: {name:string;ok:boolean}) => check.name === 'mcp_tools' && check.ok));
  assert.match(full.body,/\| mcp_tools \| ok \|/);
  for (const secret of secrets) assert.ok(!JSON.stringify(full).includes(secret));
  assert.equal(spawnSync(process.execPath,[receipts,'bug-report','--tail','abc'], { encoding:'utf8', env, timeout:20000 }).status,1);
});

test('tool errors carry the documented hint and docs link from the error taxonomy', async () => {
  const running = await startHttpServer({ port: 0, store: new MemoryAuditStore() });
  const client = new Client({ name: 'taxonomy-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const unknown = await client.callTool({ name: 'receipts.classify', arguments: { write: { ...write, surface: 'unregistered' } } });
    const error = unknown.structuredContent?.error as { code: string; message: string; hint?: string; docs?: string };
    assert.equal(error.code, 'not_a_destination_write');
    assert.equal(error.docs, 'https://github.com/77systems-ai/receipts/blob/main/docs/ERRORS.md#not_a_destination_write');
    assert.match(error.hint ?? '', /Register the surface locally/);
    assert.doesNotMatch(JSON.stringify(error), /unregistered.*unregistered/, 'the hint is static and never echoes input');
    const noConnector = await client.callTool({ name: 'receipts.observe', arguments: { request: write } });
    assert.equal((noConnector.structuredContent?.error as { code: string; docs: string }).docs, 'https://github.com/77systems-ai/receipts/blob/main/docs/ERRORS.md#connector_not_configured');
  } finally { await client.close(); await running.close(); }
});

test('observing a destination for a claim that was never dispatched completes nothing and warns about the bypassed dispatch', async () => {
  const store = new MemoryAuditStore();
  const action: ApprovedAction = { surface: 'social-publish', attemptId: 'undispatched-attempt', actionId: '00000000-0000-4000-8000-00000000d15c', destinationAccount: 'demo:account', approvalId: 'approval-undispatched', packageDigest: digest };
  const running = await startHttpServer({ port: 0, store, connectors: [{ surface: action.surface, read: async (request) => ({ destinationAccount: action.destinationAccount, destinationId: `post-${request.attemptId}`, packageDigest: digest, observedAt: '2026-09-25T10:42:00.000Z' }) }] });
  const client = new Client({ name: 'undispatched-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const claimed = await client.callTool({ name: 'receipts.claim', arguments: { action } });
    assert.equal(claimed.structuredContent?.verdict, 'CLAIMED');
    const observed = await client.callTool({ name: 'receipts.observe', arguments: { request: action } });
    assert.equal(observed.isError, undefined);
    assert.equal(observed.structuredContent?.verdict, 'complete');
    assert.equal(observed.structuredContent?.independentlyVerified, true);
    assert.equal(observed.structuredContent?.admission, undefined, 'no dispatch was recorded, so nothing completes');
    assert.deepEqual(observed.structuredContent?.warnings, ['claim_not_dispatched']);
    assert.equal(store.read().filter(entry => entry.event === 'attempt').length, 0);
    assert.equal(store.read().filter(entry => entry.event === 'claim_completed').length, 0);
    // The reservation is spent: it can neither dispatch (which would license a second write) nor release, and any reclaim is DUPLICATE.
    const lease0 = claimed.structuredContent?.claim as ClaimLease;
    const dispatched = await client.callTool({ name: 'receipts.dispatch', arguments: { claim: lease0 } });
    assert.equal(dispatched.isError, true);
    assert.equal((dispatched.structuredContent?.error as { code: string }).code, 'duplicate_attempt');
    assert.equal((await client.callTool({ name: 'receipts.release', arguments: { claim: lease0 } })).isError, true);
    assert.equal(store.read().filter(entry => entry.event === 'attempt').length, 0, 'no second write was authorized');
    const again = await client.callTool({ name: 'receipts.claim', arguments: { action: { ...action, attemptId: 'after-bypass' } } });
    assert.equal(again.structuredContent?.verdict, 'DUPLICATE');
    assert.equal(again.structuredContent?.reason, 'completed');
    assert.match(String(again.structuredContent?.hint), /Report the existing receipt/);
    assert.equal(again.structuredContent?.docs, 'https://github.com/77systems-ai/receipts/blob/main/docs/ERRORS.md#completed');
    // A properly dispatched attempt emits no warning.
    const clean: ApprovedAction = { ...action, actionId: '00000000-0000-4000-8000-00000000c1ea', attemptId: 'dispatched-attempt', approvalId: 'approval-dispatched' };
    const lease = (await client.callTool({ name: 'receipts.claim', arguments: { action: clean } })).structuredContent?.claim as ClaimLease;
    assert.equal((await client.callTool({ name: 'receipts.dispatch', arguments: { claim: lease } })).structuredContent?.verdict, 'AUTHORIZED');
    const cleanObserved = await client.callTool({ name: 'receipts.observe', arguments: { request: clean } });
    assert.equal(cleanObserved.structuredContent?.warnings, undefined);
    assert.equal((cleanObserved.structuredContent?.admission as { verdict: string }).verdict, 'COMPLETED');
  } finally { await client.close(); await running.close(); }
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
    assert.equal(observed.structuredContent?.admission,undefined,'an attempt without a lease gains no invented admission decision');
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

test('guarded write over HTTP: an independent observe completes the lease, shared budgets deny a second dispatch, and proofs sign and badge', { timeout: 20000 }, async () => {
  const store = new MemoryAuditStore();
  const keys = generateReceiptKeyPair();
  const other = generateReceiptKeyPair();
  const destinationId = 'post-guarded';
  let reads = 0;
  const running = await startHttpServer({
    port: 0, store, signingKey: keys.privateKey, claimTtlMs: 60_000,
    policy: { rateLimits: [{ id: 'one-write-per-hour', maxWrites: 1, windowMs: 3_600_000, surface: write.surface }] },
    connectors: [{ surface: write.surface, read: async () => { reads++; return { destinationAccount: write.destinationAccount, destinationId, packageDigest: approvedDigest, observedAt: '2026-09-25T10:42:00.000Z' }; } }],
  });
  const client = new Client({ name: 'guarded-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const digested = await client.callTool({ name: 'receipts.digest', arguments: { payload: approvedPayload } });
    const action = nextAction({ packageDigest: digested.structuredContent?.packageDigest as string });
    assert.equal(action.packageDigest, approvedDigest);
    const evaluated = await client.callTool({ name: 'receipts.policy', arguments: { action } });
    assert.deepEqual(evaluated.structuredContent, { verdict: 'allowed', policyConfigured: true });
    const first = await claimLease(client, action);
    const competitor = nextAction();
    const second = await claimLease(client, competitor);
    assert.equal(store.read().filter((entry) => entry.event === 'claim').length, 2);
    const dispatched = await client.callTool({ name: 'receipts.dispatch', arguments: { claim: first } });
    assert.equal(dispatched.structuredContent?.verdict, 'AUTHORIZED');
    // The shared budget is consumed by the durable dispatch, so the competitor is denied and can release.
    const denied = await client.callTool({ name: 'receipts.dispatch', arguments: { claim: second } });
    assert.equal(denied.isError, undefined);
    assert.equal(denied.structuredContent?.verdict, 'policy_denied');
    assert.equal(denied.structuredContent?.ruleId, 'one-write-per-hour');
    const released = await client.callTool({ name: 'receipts.release', arguments: { claim: second } });
    assert.equal(released.structuredContent?.verdict, 'RELEASED');
    const before = store.read().length;
    const exhausted = await client.callTool({ name: 'receipts.policy', arguments: { action: nextAction() } });
    assert.deepEqual(exhausted.structuredContent, { verdict: 'policy_denied', ruleId: 'one-write-per-hour', policyConfigured: true });
    assert.equal(store.read().length, before, 'policy evaluation records nothing');
    const lateClaim = await client.callTool({ name: 'receipts.claim', arguments: { action: nextAction() } });
    assert.equal(lateClaim.structuredContent?.verdict, 'policy_denied');
    assert.equal(lateClaim.structuredContent?.claim, undefined, 'a denied claim holds no lease');
    assert.equal(store.read().at(-1)!.registry, undefined, 'a claim-time denial is recorded without lease metadata');
    // The one outward write is represented by the connector fixture. Observing it completes the lease.
    const observed = await client.callTool({ name: 'receipts.observe', arguments: { request: { ...action, destinationId } } });
    assert.equal(observed.isError, undefined, JSON.stringify(observed.structuredContent));
    assert.equal(observed.structuredContent?.verdict, 'complete');
    assert.equal(observed.structuredContent?.independentlyVerified, true);
    assert.equal((observed.structuredContent?.admission as { verdict: string }).verdict, 'COMPLETED');
    assert.equal(reads, 1);
    const duplicate = await client.callTool({ name: 'receipts.claim', arguments: { action: { ...action, attemptId: randomUUID() } } });
    assert.equal(duplicate.structuredContent?.verdict, 'DUPLICATE');
    assert.equal(duplicate.structuredContent?.reason, 'completed');
    assert.equal(store.read().filter((entry) => entry.event === 'attempt').length, 1);
    const rechecked = await client.callTool({ name: 'receipts.recheck', arguments: { request: { ...action, destinationId } } });
    assert.equal(rechecked.structuredContent?.verdict, 'complete');
    assert.equal((rechecked.structuredContent?.admission as { verdict: string }).verdict, 'COMPLETED');
    assert.equal(store.read().filter((entry) => entry.event === 'claim_completed').length, 1, 'recheck completion is idempotent');
    assert.ok(!JSON.stringify(store.read()).includes(first.token));
    const identity = { destinationId, packageDigest: approvedDigest, scope: { actionId: action.actionId, destinationAccount: action.destinationAccount } };
    const signed = await client.callTool({ name: 'receipts.sign', arguments: identity });
    assert.equal(signed.isError, undefined, JSON.stringify(signed.structuredContent));
    const proof = signed.structuredContent as { receiptHash: string; signer: { keyId: string } };
    assert.equal(verifySignedReceipt(proof, { trustedPublicKey: keys.publicKey }).valid, true);
    assert.equal(verifySignedReceipt(proof, { trustedPublicKey: other.publicKey }).valid, false);
    assert.equal(proof.signer.keyId, keys.keyId);
    assert.ok(!JSON.stringify(proof).includes('PRIVATE KEY'));
    assert.ok(!JSON.stringify(proof).includes(first.token));
    const badge = await client.callTool({ name: 'receipts.badge', arguments: { ...identity, receiptUrl: 'https://example.com/receipts/1' } });
    assert.equal(badge.isError, undefined, JSON.stringify(badge.structuredContent));
    assert.match(badge.structuredContent?.badge as string, /^<a class="receipts-badge" .*Verified by Receipts · independently verified/);
    assert.equal(badge.structuredContent?.receiptHash, proof.receiptHash);
    assert.equal(badge.structuredContent?.keyId, keys.keyId);
    assert.equal(typeof badge.structuredContent?.signedAt, 'string');
    const insecure = await client.callTool({ name: 'receipts.badge', arguments: { ...identity, receiptUrl: 'http://example.com/receipts/1' } });
    assert.equal(code(insecure), 'invalid_receipt_url');
    assert.equal(code(await client.callTool({ name: 'receipts.badge', arguments: { ...identity, receiptUrl: 'https://user:secret@example.com/r' } })), 'invalid_receipt_url');
    assert.equal(code(await client.callTool({ name: 'receipts.sign', arguments: { destinationId: 'post-never', packageDigest: approvedDigest } })), 'receipt_not_found');
    // A cooperative receipt can be signed but never badged.
    const cooperative = nextAction();
    const cooperativeId = 'post-cooperative';
    assert.equal((await client.callTool({ name: 'receipts.record', arguments: { entry: observationEntry(cooperative, cooperativeId) } })).isError, undefined);
    assert.equal((await client.callTool({ name: 'receipts.bind', arguments: { destinationId: cooperativeId, packageDigest: approvedDigest } })).isError, undefined);
    const refused = await client.callTool({ name: 'receipts.badge', arguments: { destinationId: cooperativeId, packageDigest: approvedDigest } });
    assert.equal(code(refused), 'badge_requires_independent_completion');
    const cooperativeProof = await client.callTool({ name: 'receipts.sign', arguments: { destinationId: cooperativeId, packageDigest: approvedDigest } });
    assert.equal(cooperativeProof.isError, undefined);
    assert.equal((cooperativeProof.structuredContent?.receipt as { independentlyVerified: boolean }).independentlyVerified, false);
    assert.equal(verifySignedReceipt(cooperativeProof.structuredContent, { trustedPublicKey: keys.publicKey }).valid, true);
  } finally { await client.close(); await running.close(); }
});

test('stdio applies a host policy file, claim TTL, and signing key from CLI flags', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-mcp-flags-'));
  const keys = generateReceiptKeyPair();
  const policyPath = join(directory, 'policy.json');
  const keyPath = join(directory, 'signing.pem');
  const auditPath = join(directory, 'audit.jsonl');
  await writeFile(policyPath, JSON.stringify({ rules: [{ id: 'blocked-account', effect: 'block', destinationAccount: 'demo:blocked' }] }));
  await writeFile(keyPath, keys.privateKey, { mode: 0o600 });
  const client = new Client({ name: 'receipts-flags-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, '--audit-path', auditPath, '--policy', policyPath, '--claim-ttl', '5000', '--signing-key', keyPath],
    env: childEnv(),
    stderr: 'pipe',
  });
  let stderr = '';
  try {
    await client.connect(transport);
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const blocked = nextAction({ destinationAccount: 'demo:blocked' });
    const evaluated = await client.callTool({ name: 'receipts.policy', arguments: { action: blocked } });
    assert.deepEqual(evaluated.structuredContent, { verdict: 'policy_denied', ruleId: 'blocked-account', policyConfigured: true });
    const denied = await client.callTool({ name: 'receipts.claim', arguments: { action: blocked } });
    assert.equal(denied.isError, undefined);
    assert.equal(denied.structuredContent?.verdict, 'policy_denied');
    assert.equal(denied.structuredContent?.ruleId, 'blocked-account');
    assert.equal(denied.structuredContent?.claim, undefined);
    const store = new JsonlAuditStore(auditPath);
    assert.deepEqual(store.read().map((entry) => entry.event), ['policy_denied'], 'a denied claim leaves no claim entry');
    assert.equal(store.read()[0]!.registry, undefined);
    const allowed = nextAction();
    const lease = await claimLease(client, allowed);
    assert.ok(Date.parse(lease.expiresAt) - Date.now() <= 5000, 'the CLI TTL bounds unused reservations');
    assert.equal((await client.callTool({ name: 'receipts.release', arguments: { claim: lease } })).structuredContent?.verdict, 'RELEASED');
    const cooperative = nextAction();
    const cooperativeId = 'post-flag-cooperative';
    assert.equal((await client.callTool({ name: 'receipts.record', arguments: { entry: observationEntry(cooperative, cooperativeId) } })).isError, undefined);
    assert.equal((await client.callTool({ name: 'receipts.bind', arguments: { destinationId: cooperativeId, packageDigest: approvedDigest } })).isError, undefined);
    const signed = await client.callTool({ name: 'receipts.sign', arguments: { destinationId: cooperativeId, packageDigest: approvedDigest } });
    assert.equal(signed.isError, undefined, JSON.stringify(signed.structuredContent));
    assert.equal(verifySignedReceipt(signed.structuredContent, { trustedPublicKey: keys.publicKey }).valid, true);
    assert.equal(verifySignedReceipt(signed.structuredContent, { trustedPublicKey: generateReceiptKeyPair().publicKey }).valid, false);
    const persisted = await readFile(auditPath, 'utf8');
    assert.ok(!persisted.includes(lease.token));
    assert.ok(!persisted.includes('PRIVATE KEY'));
    assert.ok(!stderr.includes('PRIVATE KEY'));
    assert.ok(!stderr.includes('Warning'), 'a 0600 key file produces no permission warning');
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('digest refuses non-JSON payloads with a code and never echoes or persists the payload', async () => {
  const store = new MemoryAuditStore();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createReceiptsServer({ store });
  await server.connect(serverTransport);
  const client = new Client({ name: 'digest-test', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    // The in-memory transport carries values JSON cannot, so an unserializable payload reaches the tool intact.
    const refused = await client.callTool({ name: 'receipts.digest', arguments: { payload: { secret: 'never-echoed-payload-text', amount: Infinity } } });
    assert.equal(refused.isError, true);
    assert.equal(code(refused), 'invalid_payload');
    assert.ok(!JSON.stringify(refused).includes('never-echoed-payload-text'));
    assert.ok(!JSON.stringify(refused).includes('Infinity'));
    const accepted = await client.callTool({ name: 'receipts.digest', arguments: { payload: { secret: 'never-echoed-payload-text' } } });
    assert.equal(accepted.structuredContent?.packageDigest, digestPayload({ secret: 'never-echoed-payload-text' }));
    assert.ok(!JSON.stringify(accepted).includes('never-echoed-payload-text'));
    assert.equal(store.read().length, 0, 'digest persists nothing');
  } finally {
    await client.close();
    await server.close();
  }
});

test('server construction fails closed on invalid policy, TTL, or signing key before any tool exists', async () => {
  assert.throws(() => createReceiptsServer({ store: new MemoryAuditStore(), policy: { rules: [{ id: 'dup', effect: 'block' }, { id: 'dup', effect: 'allow' }] } }), errorCode('invalid_policy'));
  assert.throws(() => createReceiptsServer({ store: new MemoryAuditStore(), claimTtlMs: 0 }), errorCode('invalid_claim_ttl'));
  assert.throws(() => createReceiptsServer({ store: new MemoryAuditStore(), signingKey: 'not a key' }), errorCode('invalid_signing_key'));
  assert.throws(() => createReceiptsServer({ store: new MemoryAuditStore(), signingKey: generateKeyPairSync('x25519').privateKey }), errorCode('invalid_signing_key'));
  await assert.rejects(startHttpServer({ port: 0, store: new MemoryAuditStore(), policy: { defaultEffect: 'maybe' as 'block' } }), errorCode('invalid_policy'));
  await assert.rejects(startHttpServer({ port: 0, store: new MemoryAuditStore(), signingKey: 'not a key' }), errorCode('invalid_signing_key'));
});

test('a leased action is read back only under the attempt that dispatched it; a foreign attempt is refused before any read', async () => {
  const store = new MemoryAuditStore();
  const action: ApprovedAction = { surface: 'social-publish', attemptId: 'dispatched-original', actionId: '00000000-0000-4000-8000-00000000f0e1', destinationAccount: 'demo:account', approvalId: 'approval-foreign', packageDigest: digest };
  let reads = 0;
  const running = await startHttpServer({ port: 0, store, connectors: [{ surface: action.surface, read: async () => { reads++; return { destinationAccount: action.destinationAccount, destinationId: 'post-foreign', packageDigest: digest, observedAt: '2026-09-25T10:42:00.000Z' }; } }] });
  const client = new Client({ name: 'foreign-attempt-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const lease = (await client.callTool({ name: 'receipts.claim', arguments: { action } })).structuredContent?.claim as ClaimLease;
    assert.equal((await client.callTool({ name: 'receipts.dispatch', arguments: { claim: lease } })).structuredContent?.verdict, 'AUTHORIZED');
    const foreign = await client.callTool({ name: 'receipts.observe', arguments: { request: { ...action, attemptId: 'someone-elses-attempt' } } });
    assert.equal(foreign.isError, true);
    assert.equal((foreign.structuredContent?.error as { code: string }).code, 'attempt_mismatch');
    assert.equal(reads, 0, 'refused before the connector read');
    assert.equal(store.read().filter(entry => entry.event === 'observation').length, 0);
    const original = await client.callTool({ name: 'receipts.observe', arguments: { request: action } });
    assert.equal((original.structuredContent?.admission as { verdict: string }).verdict, 'COMPLETED');
    assert.equal(reads, 1);
  } finally { await client.close(); await running.close(); }
});

test('bug-report renders corrupt audit lines by allowlisted shape only and never echoes argument values', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-bug-report-shape-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const receipts = join(directory,'receipts');
  await symlink(fileURLToPath(new URL('../dist/receipts.js', import.meta.url)),receipts);
  const auditPath = join(directory,'audit.jsonl');
  const junk = 'https://evil.example/?token=leaked-through-shape-field';
  // A hand-edited line: every shape field carries text that must never reach the report.
  await writeFile(auditPath, `${JSON.stringify({ version: 1, sequence: 'one', previousHash: null, hash: 'x', entry: { timestamp: junk, event: junk, verdict: junk, surface: junk, admission: { verdict: junk }, evidenceSource: junk } })}\n`);
  const env = childEnv({ RECEIPTS_AUDIT_PATH: auditPath });
  const run = spawnSync(process.execPath,[receipts,'bug-report','--json','--no-doctor'], { encoding:'utf8', env, timeout:20000 });
  assert.equal(run.status,0,run.stderr);
  assert.ok(!run.stdout.includes('leaked-through-shape-field'));
  const report = JSON.parse(run.stdout);
  assert.equal(report.bundle.audit.chain,'audit_corrupt');
  assert.deepEqual(report.bundle.audit.tail, [{ sequence: -1, timestamp: 'invalid', event: 'invalid', verdict: 'invalid', surface: 'invalid', admission: 'invalid', evidenceSource: 'invalid' }]);
  for (const args of [['bug-report','--token=ghp_should_not_echo','--no-doctor'], ['doctor','--audit-path=/private/should-not-echo'], ['/private/command-should-not-echo']]) {
    const bad = spawnSync(process.execPath,[receipts,...args], { encoding:'utf8', env, timeout:20000 });
    assert.equal(bad.status,1);
    assert.ok(!`${bad.stdout}${bad.stderr}`.includes('should_not_echo') && !`${bad.stdout}${bad.stderr}`.includes('should-not-echo'), `echoed a value for ${args[0]}`);
    assert.match(bad.stderr,/Usage:/);
  }
  // The split form of a known option still works.
  const split = JSON.parse(spawnSync(process.execPath,[receipts,'bug-report','--json','--no-doctor',`--audit-path=${auditPath}`,'--tail=0'], { encoding:'utf8', env: childEnv(), timeout:20000 }).stdout);
  assert.equal(split.bundle.audit.location,'flag');
  assert.deepEqual(split.bundle.audit.tail,[]);
});
