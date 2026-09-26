import { ReceiptsError, type TrustedConnector, type ConnectorRequest } from '@77systems/receipts-core';
import { digestPayload } from '@77systems/receipts-sdk';

export const EMAIL_SEND_SURFACE = 'email-send';
// The 'email-send' surface is registered by @77systems/receipts-core; connectors use it, never re-register it.

export interface GmailPayload {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
}

/** Body normalization shared by the approved payload and the read-back observation. */
export function normalizeEmailBody(body: string): string {
  return String(body).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

export interface GmailPayloadInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
}

/** The exact approved-content contract for an email send. Addresses are trimmed; transport formatting cannot break an honest match. */
export function canonicalGmailPayload(input: GmailPayloadInput): GmailPayload {
  if (typeof input?.to !== 'string' || !input.to.trim()) throw new ReceiptsError('invalid_gmail_payload', 'An email recipient is required.');
  if (typeof input?.subject !== 'string') throw new ReceiptsError('invalid_gmail_payload', 'An email subject is required.');
  if (typeof input?.body !== 'string') throw new ReceiptsError('invalid_gmail_payload', 'An email body is required.');
  const payload: GmailPayload = {
    to: input.to.trim(),
    subject: input.subject,
    body: normalizeEmailBody(input.body),
  };
  if (input.cc !== undefined && String(input.cc).trim()) payload.cc = String(input.cc).trim();
  if (input.bcc !== undefined && String(input.bcc).trim()) payload.bcc = String(input.bcc).trim();
  if (input.html === true) payload.html = true;
  return payload;
}

function fail(code: string, message: string): never { throw new ReceiptsError(code, message); }

/** Subset of the Gmail API users.messages.get (format=full) response this connector reads. */
export interface GmailMessageHeader { name: string; value: string }
export interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}
export interface GmailMessage {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: {
    headers?: GmailMessageHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
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

function extractBody(part: GmailMessagePart | undefined, wantHtml: boolean): string | null {
  if (!part) return null;
  const mime = String(part.mimeType ?? '');
  const data = part.body?.data;
  if (mime === (wantHtml ? 'text/html' : 'text/plain') && typeof data === 'string') return base64UrlDecode(data);
  for (const sub of part.parts ?? []) {
    const found = extractBody(sub, wantHtml);
    if (found !== null) return found;
  }
  return null;
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
      const to = header(message.payload?.headers, 'To');
      if (!to) fail('object_mismatch', 'The sent message is missing its To header.');
      // Headers and body exist only in local process memory to compute this digest.
      const observed = canonicalGmailPayload({
        to,
        subject: header(message.payload?.headers, 'Subject'),
        body: extractBody(message.payload, false) ?? extractBody(message.payload, true) ?? '',
      });
      const internalMs = Number(message.internalDate);
      const observedAt = Number.isFinite(internalMs) ? new Date(internalMs).toISOString() : new Date().toISOString();
      return Object.freeze({
        destinationAccount: account,
        destinationId: id,
        packageDigest: digestPayload(observed),
        observedAt,
      });
    },
  });
}
