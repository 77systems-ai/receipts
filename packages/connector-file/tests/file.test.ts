import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connectorConformance } from '@77systems/receipts-conformance';
import { digestPayload } from '@77systems/receipts-sdk';
import { createFileConnector, filePayload, normalizeFileContent, FILE_WRITE_SURFACE, type TrustedConnector } from '../dist/index.js';

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
}, {connectorVersion:'0.3.0',seed:'file-v0.3.0',
  evaluationPath:process.env.RECEIPTS_EVALUATION_PATH ?? '.receipts/evaluations/file-0.3.0.json'});

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
