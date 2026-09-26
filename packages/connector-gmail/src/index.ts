import { ReceiptsError, type TrustedConnector, type ConnectorRequest } from '@77systems/receipts-core';
import { digestPayload } from '@77systems/receipts-sdk';

export const EMAIL_SEND_SURFACE = 'email-send';
// The 'email-send' surface is registered by @77systems/receipts-core; connectors use it, never re-register it.

/**
 * Everything a recipient can see. body is the text/plain rendering ('' when the message is
 * HTML-only); html is the text/html rendering when one is sent. Attachments are outside this
 * contract: a message carrying any other MIME part never matches.
 */
export interface GmailPayload {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: string;
}

/** Body normalization shared by the approved payload and the read-back observation. */
export function normalizeEmailBody(body: string): string {
  return String(body).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

/**
 * Canonical recipient list shared by the approved payload and the read-back observation:
 * the addr-spec of each mailbox (display names and angle brackets dropped), lowercased,
 * deduplicated, and sorted, joined with ", ". Recipients are part of the approved package,
 * so an extra or missing recipient always changes the digest; only presentation cannot.
 */
export function canonicalAddressList(value: string): string {
  const mailboxes: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === '\\' && quoted) { current += char + (value[index + 1] ?? ''); index++; continue; }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '<') angle++;
    else if (!quoted && char === '>' && angle > 0) angle--;
    if (char === ',' && !quoted && angle === 0) { mailboxes.push(current); current = ''; continue; }
    current += char;
  }
  mailboxes.push(current);
  const addresses = mailboxes.map((mailbox) => {
    const trimmed = mailbox.trim();
    const bracketed = /<([^<>]*)>\s*$/.exec(trimmed);
    return (bracketed ? bracketed[1]! : trimmed).trim().toLowerCase();
  }).filter(Boolean);
  return [...new Set(addresses)].sort().join(', ');
}

export interface GmailPayloadInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  /** The approved text/plain+text/html alternative's HTML body. Omit for plain-text mail. */
  html?: string;
}

/**
 * The exact approved-content contract for an email send: canonical To, Cc, and Bcc recipient
 * lists, the trimmed subject, the normalized plain body, and the normalized HTML body when sent.
 * Presentation (display names, recipient order and case, line endings, trailing whitespace)
 * cannot break an honest match; a different recipient set or content always does.
 */
export function canonicalGmailPayload(input: GmailPayloadInput): GmailPayload {
  if (typeof input?.to !== 'string' || !canonicalAddressList(input.to)) throw new ReceiptsError('invalid_gmail_payload', 'An email recipient is required.');
  if (typeof input?.subject !== 'string') throw new ReceiptsError('invalid_gmail_payload', 'An email subject is required.');
  if (typeof input?.body !== 'string') throw new ReceiptsError('invalid_gmail_payload', 'An email body is required.');
  for (const key of ['cc', 'bcc', 'html'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new ReceiptsError('invalid_gmail_payload', `The ${key} field must be a string.`);
  }
  const payload: GmailPayload = {
    to: canonicalAddressList(input.to),
    subject: input.subject.trim(),
    body: normalizeEmailBody(input.body),
  };
  const cc = input.cc === undefined ? '' : canonicalAddressList(input.cc);
  const bcc = input.bcc === undefined ? '' : canonicalAddressList(input.bcc);
  if (cc) payload.cc = cc;
  if (bcc) payload.bcc = bcc;
  const html = input.html === undefined ? '' : normalizeEmailBody(input.html);
  if (html) payload.html = html;
  return payload;
}

function fail(code: string, message: string): never { throw new ReceiptsError(code, message); }

/** Subset of the Gmail API users.messages.get (format=full) response this connector reads. */
export interface GmailMessageHeader { name: string; value: string }
export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}
export interface GmailMessage {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailMessagePart & { headers?: GmailMessageHeader[] };
}

/**
 * Dependency-injected Gmail read: (messageId) => the message, as returned by
 * users.messages.get with format=full. The connector never imports a mail
 * client; the operator supplies whatever authenticated client they trust.
 */
export type GmailMessageFetcher = (messageId: string) => Promise<GmailMessage>;

export interface GmailConnectorOptions {
  /** Local destination account label, e.g. the mailbox address. Must match the claim's destinationAccount. */
  account: string;
  getMessage: GmailMessageFetcher;
  timeoutMs?: number;
}

function header(headers: GmailMessageHeader[] | undefined, name: string): string {
  const found = (headers ?? []).find((h) => String(h?.name ?? '').toLowerCase() === name.toLowerCase());
  return found ? String(found.value ?? '') : '';
}

function base64UrlDecode(data: string): string {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

interface Renderings { plain: string[]; html: string[]; other: number }

/** Walk every MIME leaf. Inline text/plain and text/html bodies are renderings; anything else is an unapproved part. */
function renderings(part: GmailMessagePart | undefined, found: Renderings = { plain: [], html: [], other: 0 }): Renderings {
  if (!part) return found;
  if (part.parts?.length) { for (const sub of part.parts) renderings(sub, found); return found; }
  const mime = String(part.mimeType ?? '').toLowerCase();
  const data = part.body?.data;
  const attachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
  if (!attachment && mime === 'text/plain' && typeof data === 'string') found.plain.push(base64UrlDecode(data));
  else if (!attachment && mime === 'text/html' && typeof data === 'string') found.html.push(base64UrlDecode(data));
  else if (mime || data || attachment) found.other++;
  return found;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('gmail read timed out')), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/**
 * Local read-only Gmail connector. It re-reads the sent message from the
 * mailbox and digests the exact approved content, so a message only binds
 * when the destination holds the approved bytes. A failed read is never a
 * verification; provider errors are never copied into the audit.
 */
export function createGmailConnector(options: GmailConnectorOptions): TrustedConnector {
  const account = options.account?.trim();
  if (!account) fail('invalid_gmail_account', 'The Gmail connector needs an account label.');
  if (typeof options.getMessage !== 'function') fail('invalid_gmail_client', 'The Gmail connector needs a getMessage function.');
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('invalid_timeout', 'Read timeout must be between 1 and 60000 milliseconds.');
  const getMessage = options.getMessage;

  return Object.freeze({
    surface: EMAIL_SEND_SURFACE,
    async read(request: ConnectorRequest) {
      if (request.destinationAccount !== account) fail('account_mismatch', 'The requested destination account does not match this connector.');
      const messageId = request.locator?.messageId;
      if (typeof messageId !== 'string' || !messageId.trim()) fail('invalid_locator', 'Provide locator.messageId from the send result.');
      let message: GmailMessage;
      try {
        message = await withTimeout(getMessage(messageId.trim()), timeoutMs);
      } catch { return fail('connector_read_failed', 'The sent message could not be read. No verification was issued; do not repeat the write.'); }
      const id = typeof message?.id === 'string' && message.id ? message.id : '';
      if (!id) fail('object_mismatch', 'The sent message could not be found. No verification was issued; do not repeat the write.');
      const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
      if (!labels.includes('SENT')) fail('object_mismatch', 'The message exists but is not in Sent; it was not an outward write.');
      const headers = message.payload?.headers;
      const to = header(headers, 'To');
      if (!canonicalAddressList(to)) fail('object_mismatch', 'The sent message is missing its To header.');
      // Headers and body exist only in local process memory to compute this digest. Every
      // recipient header the Sent copy carries is observed, so an unapproved Cc or Bcc can
      // never match an approval that lacks it.
      const recipients = { to, subject: header(headers, 'Subject'), cc: header(headers, 'Cc'), bcc: header(headers, 'Bcc') };
      // Every rendering the recipient could see is observed. A second text part of either kind or
      // any other MIME part (attachment, calendar, image) is outside the contract and is counted
      // into the observed package, so such a message can never match an approval.
      const found = renderings(message.payload);
      const extra = found.other + Math.max(0, found.plain.length - 1) + Math.max(0, found.html.length - 1);
      const observed = {
        ...canonicalGmailPayload({ ...recipients, body: found.plain[0] ?? '', ...(found.html[0] !== undefined ? { html: found.html[0] } : {}) }),
        ...(extra ? { unapprovedParts: extra } : {}),
      };
      const packageDigest = digestPayload(observed);
      return Object.freeze({
        destinationAccount: account,
        destinationId: id,
        packageDigest,
        // The time of this read, never the message's send time: rechecks must record when they looked.
        observedAt: new Date().toISOString(),
      });
    },
  });
}
