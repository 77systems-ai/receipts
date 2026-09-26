import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assessCertification, connectorConformance, evaluationDigest, type EvaluationReceipt } from '@77systems/receipts-conformance';
import { digestPayload } from '@77systems/receipts-sdk';
import {
  createGmailConnector, canonicalGmailPayload, canonicalAddressList, normalizeEmailBody, EMAIL_SEND_SURFACE,
  type GmailMessage, type GmailMessageFetcher,
} from '../dist/index.js';

const VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

const ACCOUNT = 'agent@example.com';
const MESSAGE_ID = '18d3ab4f2c1e9a00';
const TO = 'founder@example.com';
const SUBJECT = 'Approved subject';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface FixtureMessage { to: string; subject: string; body: string; labelIds: string[]; cc?: string; bcc?: string; html?: string; attachment?: boolean }

/** A plain-text message unless the fixture adds an HTML alternative or an attachment. */
function toApiMessage(id: string, message: FixtureMessage): GmailMessage {
  const headers = [
    { name: 'To', value: message.to },
    { name: 'Subject', value: message.subject },
    ...(message.cc !== undefined ? [{ name: 'Cc', value: message.cc }] : []),
    ...(message.bcc !== undefined ? [{ name: 'Bcc', value: message.bcc }] : []),
  ];
  const plain = { mimeType: 'text/plain', body: { data: base64Url(message.body) } };
  const parts = [plain,
    ...(message.html !== undefined ? [{ mimeType: 'text/html', body: { data: base64Url(message.html) } }] : []),
    ...(message.attachment ? [{ mimeType: 'application/pdf', filename: 'q3.pdf', body: { attachmentId: 'att-1' } }] : [])];
  return {
    id,
    labelIds: message.labelIds,
    internalDate: '1700000000000',
    payload: parts.length === 1 ? { headers, ...plain } : { headers, mimeType: 'multipart/mixed', parts },
  };
}

const request = (destinationAccount: string, packageDigest: string, locator: Record<string, string | number> = { messageId: MESSAGE_ID }) => ({
  surface: EMAIL_SEND_SURFACE, attemptId: randomUUID(), actionId: randomUUID(),
  approvalId: randomUUID(), destinationAccount, packageDigest, locator,
});

connectorConformance('Gmail connector', () => {
  let state: FixtureMessage | undefined;
  let writeCount = 0, readCount = 0;
  let readFailure = false;
  const payload = canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 'Approved body\n' });
  const getMessage: GmailMessageFetcher = async (id) => {
    readCount++;
    assert.equal(id, MESSAGE_ID);
    if (readFailure) throw new Error('synthetic provider failure');
    if (!state) throw new Error('synthetic 404: message not found');
    return toApiMessage(MESSAGE_ID, state);
  };
  const connector = createGmailConnector({ account: ACCOUNT, getMessage });
  return {
    connector, payload,
    destinationAccount: ACCOUNT, destinationId: MESSAGE_ID, locator: { messageId: MESSAGE_ID },
    write() {
      writeCount++;
      // The approved body normalizes to 'Approved body'; the destination may carry transport formatting.
      state = { to: TO, subject: SUBJECT, body: 'Approved body\r\n', labelIds: ['SENT'] };
    },
    writes() { return writeCount; },
    reads() { return readCount; },
    changeContent() { state = { ...(state as FixtureMessage), body: 'tampered after verification' }; },
    setWrongAccount() {
      // The message exists in this mailbox but is not a sent outward write:
      // the read fails closed instead of verifying the wrong object.
      state = { ...(state as FixtureMessage), labelIds: ['INBOX'] };
    },
    setReadFailure() { readFailure = true; },
  };
}, {connectorVersion:VERSION,seed:`gmail-v${VERSION}`,
  // Ordinary runs write under ignored .receipts/; `npm run evaluate:connectors` regenerates docs/evaluations deliberately.
  evaluationPath:process.env.RECEIPTS_EVALUATION_PATH ?? `.receipts/evaluations/gmail-${VERSION}.json`});

test('Gmail rejects a message that is not in Sent', async t => {
  let calls = 0;
  const getMessage: GmailMessageFetcher = async () => {
    calls++;
    return toApiMessage(MESSAGE_ID, { to: TO, subject: SUBJECT, body: 'x', labelIds: ['INBOX', 'DRAFT'] });
  };
  const connector = createGmailConnector({ account: ACCOUNT, getMessage });
  const payload = canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 'x' });
  await assert.rejects(
    () => connector.read(request(ACCOUNT, digestPayload(payload))),
    { code: 'object_mismatch' },
  );
  assert.equal(calls, 1);
});

test('Gmail rejects wrong accounts and unsafe locators before reading', async t => {
  let calls = 0;
  const getMessage: GmailMessageFetcher = async () => { calls++; throw new Error('must not be called'); };
  const connector = createGmailConnector({ account: ACCOUNT, getMessage });
  const payload = canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 'x' });
  await assert.rejects(
    () => connector.read(request('other@example.com', digestPayload(payload))),
    { code: 'account_mismatch' },
  );
  for (const messageId of [undefined, '', '   ', 42]) {
    await assert.rejects(
      () => connector.read(request(ACCOUNT, digestPayload(payload), { messageId: messageId as string })),
      { code: 'invalid_locator' },
    );
  }
  assert.equal(calls, 0);
});

test('Gmail binds only byte-identical approved content; tampering changes the digest', async t => {
  const approved = canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 'Approved body' });
  const approvedDigest = digestPayload(approved);
  const good: GmailMessageFetcher = async () => toApiMessage(MESSAGE_ID, { to: TO, subject: SUBJECT, body: 'Approved body', labelIds: ['SENT'] });
  const observed = await createGmailConnector({ account: ACCOUNT, getMessage: good })
    .read(request(ACCOUNT, approvedDigest));
  assert.equal(observed.destinationId, MESSAGE_ID);
  assert.equal(observed.packageDigest, approvedDigest);
  assert.equal(observed.destinationAccount, ACCOUNT);
  const tampered: GmailMessageFetcher = async () => toApiMessage(MESSAGE_ID, { to: TO, subject: SUBJECT, body: 'Approved body, plus a lie', labelIds: ['SENT'] });
  const observedTampered = await createGmailConnector({ account: ACCOUNT, getMessage: tampered })
    .read(request(ACCOUNT, approvedDigest));
  assert.notEqual(observedTampered.packageDigest, approvedDigest);
});

test('Gmail normalizes transport formatting so honest matches bind', async t => {
  const approved = canonicalGmailPayload({ to: '  founder@example.com ', subject: SUBJECT, body: 'Hello\r\nworld  \r\n\r\n' });
  const getMessage: GmailMessageFetcher = async () => toApiMessage(
    MESSAGE_ID,
    { to: 'founder@example.com', subject: SUBJECT, body: 'Hello\r\nworld  \r\n\r\n', labelIds: ['SENT'] },
  );
  const observed = await createGmailConnector({ account: ACCOUNT, getMessage })
    .read(request(ACCOUNT, digestPayload(approved)));
  assert.equal(observed.packageDigest, digestPayload(approved));
});

test('Gmail fails closed on provider errors and timeouts without leaking them', async t => {
  const secret = 'provider-secret-do-not-retain';
  const failing: GmailMessageFetcher = async () => { throw new Error(`${secret}: exploded`); };
  const hanging: GmailMessageFetcher = async () => new Promise<GmailMessage>(() => {});
  const payload = canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 'x' });
  for (const getMessage of [failing]) {
    await assert.rejects(
      () => createGmailConnector({ account: ACCOUNT, getMessage }).read(request(ACCOUNT, digestPayload(payload))),
      (error) => {
        assert.equal((error as { code: string }).code, 'connector_read_failed');
        assert.ok(!String(error).includes(secret));
        return true;
      },
    );
  }
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(
      () => createGmailConnector({ account: ACCOUNT, getMessage: hanging, timeoutMs: 20 }).read(request(ACCOUNT, digestPayload(payload))),
      { code: 'connector_read_failed' },
    );
  } finally { clearTimeout(keepAlive); }
});

test('Gmail canonical payload canonicalizes recipient lists and keeps cc/bcc/html only when set', () => {
  assert.equal(normalizeEmailBody('a\r\nb  \n\n'), 'a\nb');
  const base = canonicalGmailPayload({ to: ` ${TO} `, subject: ` ${SUBJECT} `, body: 'x\n' });
  assert.deepEqual(base, { to: TO, subject: SUBJECT, body: 'x' });
  const full = canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 'x', cc: 'cc@example.com ', bcc: '', html: '<p>x</p>\n' });
  assert.deepEqual(full, { to: TO, subject: SUBJECT, body: 'x', cc: 'cc@example.com', html: '<p>x</p>' });
  assert.equal(canonicalAddressList('"Doe, Jane" <Jane@Example.com>, bob@example.com ,  <jane@example.com>'), 'bob@example.com, jane@example.com');
  assert.equal(canonicalAddressList('Alice <alice@example.com>'), 'alice@example.com');
  assert.equal(canonicalAddressList(' , '), '');
  assert.throws(() => canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 'x', html: true as unknown as string }), { code: 'invalid_gmail_payload' });
  assert.throws(() => canonicalGmailPayload({ to: ' ', subject: SUBJECT, body: 'x' }), { code: 'invalid_gmail_payload' });
  assert.throws(() => canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 42 as unknown as string }), { code: 'invalid_gmail_payload' });
});

test('Gmail sent message id matches the registered email-send surface pattern', async t => {
  const payload = canonicalGmailPayload({ to: TO, subject: SUBJECT, body: 'x' });
  const getMessage: GmailMessageFetcher = async () => toApiMessage(MESSAGE_ID, { to: TO, subject: SUBJECT, body: 'x', labelIds: ['SENT'] });
  const observed = await createGmailConnector({ account: ACCOUNT, getMessage })
    .read(request(ACCOUNT, digestPayload(payload)));
  assert.match(observed.destinationId, /^[A-Za-z0-9<][A-Za-z0-9._:@<>+-]{0,255}$/);
});

async function observe(approved: Parameters<typeof canonicalGmailPayload>[0], sent: FixtureMessage) {
  const approvedDigest = digestPayload(canonicalGmailPayload(approved));
  const observed = await createGmailConnector({ account: ACCOUNT, getMessage: async () => toApiMessage(MESSAGE_ID, sent) })
    .read(request(ACCOUNT, approvedDigest));
  return { matches: observed.packageDigest === approvedDigest, observed };
}

test('Gmail never binds a sent message with an unapproved recipient, rendering, or attachment', async () => {
  const approved = { to: TO, subject: SUBJECT, body: 'Q3 numbers' };
  const sent: FixtureMessage = { to: TO, subject: SUBJECT, body: 'Q3 numbers', labelIds: ['SENT'] };
  assert.equal((await observe(approved, sent)).matches, true, 'the exact approved message binds');
  for (const [label, change] of [
    ['an unapproved Bcc', { bcc: 'attacker@evil.example' }],
    ['an unapproved Cc', { cc: 'someone@else.example' }],
    ['an extra To recipient', { to: `${TO}, attacker@evil.example` }],
    ['an unapproved HTML alternative', { html: '<p>click evil.example</p>' }],
    ['an unapproved attachment', { attachment: true }],
  ] as const) {
    assert.equal((await observe(approved, { ...sent, ...change })).matches, false, `${label} must not bind`);
  }
});

test('Gmail binds approved Cc, Bcc, and HTML alternatives regardless of address presentation', async () => {
  const approved = { to: `${TO}, second@example.com`, cc: 'bob@example.com', bcc: 'audit@example.com', subject: SUBJECT, body: 'Q3 numbers', html: '<p>Q3 numbers</p>' };
  const sent: FixtureMessage = { to: '"Second" <SECOND@example.com>, Founder <founder@example.com>', cc: 'Bob <bob@example.com>', bcc: 'audit@example.com',
    subject: SUBJECT, body: 'Q3 numbers\r\n', html: '<p>Q3 numbers</p>\r\n', labelIds: ['SENT'] };
  assert.equal((await observe(approved, sent)).matches, true);
  // Each approved rendering and recipient is required: dropping one from the sent message breaks the match.
  for (const change of [{ html: undefined }, { cc: undefined }, { bcc: undefined }, { html: '<p>Q3 numbers, edited</p>' }]) {
    assert.equal((await observe(approved, { ...sent, ...change })).matches, false);
  }
});

test('Gmail observedAt is the time of the read, never the message send time', async () => {
  const before = Date.now();
  const { observed } = await observe({ to: TO, subject: SUBJECT, body: 'x' }, { to: TO, subject: SUBJECT, body: 'x', labelIds: ['SENT'] });
  const observedAt = Date.parse(observed.observedAt);
  assert.ok(observedAt >= before && observedAt <= Date.now(), 'internalDate (2023) must not become the observation time');
});

test('the committed public Gmail evaluation matches the current benchmark and connector version', () => {
  // `npm test` never rewrites this artifact; `npm run evaluate:connectors` regenerates it deliberately.
  const evaluation = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../docs/evaluations/gmail-${VERSION}.json`, import.meta.url)), 'utf8')) as EvaluationReceipt;
  assert.equal(evaluation.connector.version, VERSION, 'run npm run evaluate:connectors after a connector version change');
  assert.equal(evaluation.connector.name, 'Gmail connector');
  assert.equal(evaluation.summary.conforms, true);
  assert.deepEqual(assessCertification(evaluation).reasons, ['published_evaluation_declaration_required'], 'the committed evaluation must be conformant and only lack a publication declaration');
  assert.match(evaluationDigest(evaluation), /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(evaluation), /\/home\/|\/Users\/|\/tmp\/|ya29\.|Bearer /, 'the public artifact carries no paths or credentials');
});
