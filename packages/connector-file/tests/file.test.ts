import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assessCertification, connectorConformance, evaluationDigest, type EvaluationReceipt } from '@77systems/receipts-conformance';
import { digestPayload } from '@77systems/receipts-sdk';
import { copyFileSync } from 'node:fs';
import { createFileConnector, filePayload, normalizeFileContent, stageFilePayload, FILE_WRITE_SURFACE, type TrustedConnector } from '../dist/index.js';

const VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

const CONTENT = 'approved file content\nsecond line\n';
const request = (destinationAccount: string, path: string, packageDigest: string) => ({
  surface: FILE_WRITE_SURFACE, attemptId: randomUUID(), actionId: randomUUID(),
  approvalId: randomUUID(), destinationAccount, packageDigest, locator: { path },
});

connectorConformance('File connector', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-'));
  const outside = mkdtempSync(join(tmpdir(), 'receipts-file-outside-'));
  const path = join(dir, 'note.txt');
  const payload = filePayload(path, CONTENT);
  let writeCount = 0, readCount = 0;
  const inner = createFileConnector({ roots: [dir] });
  const connector: TrustedConnector = {
    surface: inner.surface,
    read(request) { readCount++; return inner.read(request); },
  };
  return {
    connector, payload,
    destinationAccount: 'local:file', destinationId: `file:${path}`, locator: { path },
    write() { writeCount++; writeFileSync(path, CONTENT, 'utf8'); },
    writes() { return writeCount; },
    reads() { return readCount; },
    changeContent() { writeFileSync(path, 'tampered after verification', 'utf8'); },
    setWrongAccount() {
      // The destination object moved outside the connector's trusted roots:
      // the read fails closed instead of verifying the wrong object.
      renameSync(path, join(outside, 'note.txt'));
      symlinkSync(join(outside, 'note.txt'), path);
    },
    setReadFailure() {
      try { unlinkSync(path); } catch { /* already gone */ }
    },
    dispose() { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); },
  };
}, {connectorVersion:VERSION,seed:`file-v${VERSION}`,
  // Ordinary runs write under ignored .receipts/; `npm run evaluate:connectors` regenerates docs/evaluations deliberately.
  evaluationPath:process.env.RECEIPTS_EVALUATION_PATH ?? `.receipts/evaluations/file-${VERSION}.json`});

test('File rejects unsafe locators before touching the filesystem', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'note.txt');
  writeFileSync(path, CONTENT, 'utf8');
  const payload = filePayload(path, CONTENT);
  const connector = createFileConnector();
  for (const bad of [undefined, '', '   ', 'relative/path.txt', 42]) {
    await assert.rejects(
      () => connector.read(request('local:file', bad as string, digestPayload(payload))),
      { code: 'invalid_locator' },
    );
  }
  await assert.rejects(
    () => connector.read(request('other-account', path, digestPayload(payload))),
    { code: 'account_mismatch' },
  );
});

test('File fails closed when the destination cannot be read back', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, 'never-written.txt');
  const connector = createFileConnector();
  await assert.rejects(
    () => connector.read(request('local:file', missing, digestPayload(filePayload(missing, '')))),
    (error) => {
      assert.equal((error as { code: string }).code, 'connector_read_failed');
      assert.equal((error as Error).message, 'The written file could not be read back. No verification was issued; do not repeat the write.');
      return true;
    },
  );
});

test('File enforces allowed roots and normalizes content before digesting', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-'));
  const outside = mkdtempSync(join(tmpdir(), 'receipts-file-outside-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const inside = join(dir, 'note.txt');
  const elsewhere = join(outside, 'note.txt');
  writeFileSync(inside, 'same\r\ncontent\r\n', 'utf8');
  writeFileSync(elsewhere, 'same\r\ncontent\r\n', 'utf8');
  const connector = createFileConnector({ roots: [dir] });
  const payload = filePayload(inside, 'same\ncontent\n');
  const observed = await connector.read(request('local:file', inside, digestPayload(payload)));
  assert.equal(observed.destinationId, `file:${inside}`);
  assert.equal(observed.packageDigest, digestPayload(payload));
  assert.equal(observed.destinationAccount, 'local:file');
  // Same bytes elsewhere are outside the trusted roots.
  await assert.rejects(
    () => connector.read(request('local:file', elsewhere, digestPayload(payload))),
    { code: 'object_mismatch' },
  );
});

test('File normalizes line endings and trailing newlines in the approved contract', () => {
  assert.equal(normalizeFileContent('a\r\nb\r\n\r\n'), 'a\nb');
  assert.equal(normalizeFileContent('a\n'), 'a');
  assert.equal(filePayload(' /x ', null).content, '');
  assert.throws(() => filePayload('', 'x'), { code: 'invalid_file_payload' });
  assert.throws(() => filePayload('/x', 42 as unknown as string), { code: 'invalid_file_payload' });
});

test('File destinationId matches the registered file-write surface pattern', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'note.txt');
  writeFileSync(path, CONTENT, 'utf8');
  const observed = await createFileConnector().read(
    request('local:file', path, digestPayload(filePayload(path, CONTENT))),
  );
  assert.match(observed.destinationId, /^file:\/[^\u0000\r\n]+$/);
});

const read = (connector: TrustedConnector, path: string, approved: string) =>
  connector.read(request('local:file', path, digestPayload(filePayload(path, approved))));

test('File never lets invalid UTF-8 or a byte-order mark collide with approved text', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const connector = createFileConnector({ roots: [dir] });
  const binary = join(dir, 'binary');
  writeFileSync(binary, Buffer.from([0xff]));
  // Lossy decoding would turn 0xFF into U+FFFD and falsely match approved "\uFFFD".
  const observed = await read(connector, binary, '\uFFFD');
  assert.notEqual(observed.packageDigest, digestPayload(filePayload(binary, '\uFFFD')));
  assert.equal(observed.destinationId, `file:${binary}`, 'the object exists; only its content cannot be approved text');
  const bom = join(dir, 'bom.txt');
  writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text')]));
  assert.notEqual((await read(connector, bom, 'text')).packageDigest, digestPayload(filePayload(bom, 'text')));
  assert.equal((await read(connector, bom, '\uFEFFtext')).packageDigest, digestPayload(filePayload(bom, '\uFEFFtext')));
});

test('File reads only regular files within the size limit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'folder');
  mkdirSync(folder);
  await assert.rejects(() => read(createFileConnector({ roots: [dir] }), folder, ''), { code: 'object_mismatch' });
  const big = join(dir, 'big.txt');
  writeFileSync(big, 'x'.repeat(64));
  await assert.rejects(() => read(createFileConnector({ roots: [dir], maxBytes: 32 }), big, 'x'.repeat(64)), { code: 'file_too_large' });
  assert.equal((await read(createFileConnector({ roots: [dir], maxBytes: 64 }), big, 'x'.repeat(64))).packageDigest, digestPayload(filePayload(big, 'x'.repeat(64))));
});

test('File admits files under a symlinked root and rejects relative or empty roots', async t => {
  const base = mkdtempSync(join(tmpdir(), 'receipts-file-root-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'real'));
  symlinkSync(join(base, 'real'), join(base, 'link'));
  const path = join(base, 'link', 'note.txt');
  writeFileSync(path, CONTENT);
  const observed = await read(createFileConnector({ roots: [join(base, 'link')] }), path, CONTENT);
  assert.equal(observed.packageDigest, digestPayload(filePayload(path, CONTENT)));
  for (const roots of [['relative/root'], []]) assert.throws(() => createFileConnector({ roots }), { code: 'invalid_file_roots' });
  assert.throws(() => createFileConnector({ accountId: 'bad\naccount' }), { code: 'invalid_file_account' });
});

test('the committed public File evaluation matches the current benchmark and connector version', () => {
  // `npm test` never rewrites this artifact; `npm run evaluate:connectors` regenerates it deliberately.
  const evaluation = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../docs/evaluations/file-${VERSION}.json`, import.meta.url)), 'utf8')) as EvaluationReceipt;
  assert.equal(evaluation.connector.version, VERSION, 'run npm run evaluate:connectors after a connector version change');
  assert.equal(evaluation.connector.name, 'File connector');
  assert.equal(evaluation.summary.conforms, true);
  assert.deepEqual(assessCertification(evaluation).reasons, ['published_evaluation_declaration_required'], 'the committed evaluation must be conformant and only lack a publication declaration');
  assert.match(evaluationDigest(evaluation), /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(evaluation), /\/home\/|\/Users\/|\/tmp\/|ya29\.|Bearer /, 'the public artifact carries no paths or credentials');
});

test('a payload staged from a file verifies once that exact file is copied to its destination', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const staged = join(dir, 'staging', 'runbook.md');
  mkdirSync(join(dir, 'staging'));
  writeFileSync(staged, '# Runbook\r\n\r\nPublish.\r\n');
  const destination = join(dir, 'published', 'nested', 'runbook.md'); // Its directories do not exist yet.
  const payload = stageFilePayload(staged, destination, { roots: [dir] });
  assert.deepEqual(payload, filePayload(destination, '# Runbook\n\nPublish.'));
  mkdirSync(join(dir, 'published', 'nested'), { recursive: true });
  copyFileSync(staged, destination);
  const observed = await read(createFileConnector({ roots: [dir] }), destination, payload.content);
  assert.equal(observed.packageDigest, digestPayload(payload), 'the claimed bytes are the written bytes');
});

test('staging refuses paths outside the roots, the same path twice, and non-text sources', t => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-file-stage-'));
  const outside = mkdtempSync(join(tmpdir(), 'receipts-file-stage-outside-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const staged = join(dir, 'staged.md');
  writeFileSync(staged, 'approved');
  const foreign = join(outside, 'staged.md');
  writeFileSync(foreign, 'approved');
  const binary = join(dir, 'binary');
  writeFileSync(binary, Buffer.from([0xff, 0xfe]));
  const roots = { roots: [dir] };
  assert.throws(() => stageFilePayload(foreign, join(dir, 'out.md'), roots), { code: 'object_mismatch' });
  assert.throws(() => stageFilePayload(staged, join(outside, 'out.md'), roots), { code: 'object_mismatch' });
  assert.throws(() => stageFilePayload(staged, staged, roots), { code: 'invalid_file_payload' });
  assert.throws(() => stageFilePayload(binary, join(dir, 'out.md'), roots), { code: 'staged_file_not_text' });
  assert.throws(() => stageFilePayload(join(dir, 'missing.md'), join(dir, 'out.md'), roots), { code: 'connector_read_failed' });
  assert.throws(() => stageFilePayload('relative.md', join(dir, 'out.md'), roots), { code: 'invalid_locator' });
  assert.throws(() => stageFilePayload(staged, join(dir, 'out.md'), { roots: [dir], maxBytes: 4 }), { code: 'file_too_large' });
});
