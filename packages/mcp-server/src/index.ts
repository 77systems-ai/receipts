import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  bind, classify, record, verify, getReceipt, observeDestination, getDefaultStore, createIdempotencyRegistry, validatePolicy, ReceiptsError,
  type AuditStore, type TrustedConnector, type ConnectorRequest, type WritePolicy, type IdempotencyRegistry, type Receipt,
} from '@77systems/receipts-core';
import { digestPayload, PAYLOAD_ENCODING } from '@77systems/receipts-sdk';
import { signReceipt, renderReceiptBadge } from '@77systems/receipts-proof';

const text = z.string().min(1);
const evidenceSchema = z.object({
  source: z.enum(['provider', 'human', 'executor', 'binding']),
  detail: text,
  observedAt: text.optional(),
  destinationId: text.optional(),
  packageDigest: text.optional(),
  reference: text.optional(),
  detailDigest: text.optional(),
  referenceDigest: text.optional(),
}).strict();

// These are wire shapes only. Digest, surface, evidence, and verdict rules live in core.
const writeSchema = z.object({
  actionId: text.optional(),
  destinationAccount: text.optional(),
  approvalId: text.optional(),
  evidenceSource: z.enum(['host-supplied', 'receipts-read']).optional(),
  independentlyVerified: z.boolean().optional(),
  observedAt: text.optional(),
  observedPackageDigest: text.optional(),
  surface: text,
  attemptId: text,
  packageDigest: text,
  idempotencyKey: text.optional(),
  destinationId: text.optional(),
  boundPackageDigest: text.optional(),
  neverReached: z.boolean().optional(),
  writeMayHaveHappened: z.boolean().optional(),
  publicObjectExists: z.boolean().optional(),
  statusFlag: z.string().optional(),
  rearm: z.object({
    causeFixed: z.boolean(), previousDigest: text, previousAttemptId: text,
  }).strict().optional(),
  evidence: z.array(evidenceSchema).optional(),
}).strict();
const entrySchema = writeSchema.extend({
  id: text,
  timestamp: text,
  verdict: z.enum(['prewrite', 'delivery_unknown', 'package_unverified', 'complete']),
  event: z.enum(['attempt', 'classification', 'observation', 'binding', 'recheck']),
  evidence: z.array(evidenceSchema),
});
const scopeSchema = z.object({destinationAccount:text.optional(),actionId:text.optional(),surface:text.optional(),attemptId:text.optional()}).strict();
const identitySchema = { destinationId: text, packageDigest: text, scope: scopeSchema.optional() };
const connectorRequestSchema = z.object({
  surface:text,attemptId:text,actionId:text,destinationAccount:text,approvalId:text,packageDigest:text,
  destinationId:text.optional(),locator:z.record(z.string(),z.union([z.string(),z.number()])).optional(),
});
// Admission wire shapes. Identity, lease, fence, and policy semantics are owned by the core registry.
const approvedActionSchema = z.object({
  surface: text, attemptId: text, actionId: text, destinationAccount: text, approvalId: text, packageDigest: text,
  idempotencyKey: text.optional(),
}).strict();
const claimLeaseSchema = approvedActionSchema.extend({
  leaseId: text, token: text, expiresAt: text, fence: z.number().int().positive(),
}).strict();
export const RECEIPTS_TOOL_NAMES = [
  'receipts.classify','receipts.record','receipts.bind','receipts.verify','receipts.observe','receipts.recheck',
  'receipts.digest','receipts.policy','receipts.claim','receipts.dispatch','receipts.release','receipts.complete','receipts.sign','receipts.badge',
] as const;


async function result(action: () => object | Promise<object>): Promise<CallToolResult> {
  try {
    const value = await action();
    return {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
    };
  } catch (error) {
    const value = {
      error: {
        code: error instanceof ReceiptsError ? error.code : 'internal_error',
        message: error instanceof ReceiptsError ? error.message : 'Receipts could not complete the operation.',
      },
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
    };
  }
}

export interface ServerOptions {
  store?: AuditStore;
  connectors?: readonly TrustedConnector[];
  /** Host-owned startup configuration applied to claim and dispatch. No tool call can read or change it. */
  policy?: WritePolicy;
  /** TTL for unused reservations. Dispatched claims never expire into another write. */
  claimTtlMs?: number;
  /** Opt-in local Ed25519 private key (PEM PKCS8 or KeyObject) for receipts.sign and receipts.badge. Never audited. */
  signingKey?: string | KeyObject;
}

interface ResolvedConfig {
  audit: AuditStore;
  connectors: readonly TrustedConnector[];
  policy?: WritePolicy;
  registry: IdempotencyRegistry;
  privateKey?: KeyObject;
}

function resolveSigningKey(signingKey: string | KeyObject | undefined): KeyObject | undefined {
  if (signingKey === undefined) return undefined;
  let key: KeyObject;
  try { key = typeof signingKey === 'string' ? createPrivateKey(signingKey) : signingKey; }
  catch { throw new ReceiptsError('invalid_signing_key', 'The signing key must be a PEM PKCS8 Ed25519 private key.'); }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new ReceiptsError('invalid_signing_key', 'The signing key must be a PEM PKCS8 Ed25519 private key.');
  }
  return key;
}

/** Startup fails closed on an invalid policy, TTL, or key; nothing here performs I/O. */
function resolveConfig({ store, connectors = [], policy, claimTtlMs, signingKey }: ServerOptions): ResolvedConfig {
  const audit = store ?? getDefaultStore();
  if (policy !== undefined) validatePolicy(policy);
  return {
    audit, connectors,
    ...(policy !== undefined ? { policy: structuredClone(policy) } : {}),
    registry: createIdempotencyRegistry({ store: audit, ...(claimTtlMs !== undefined ? { ttlMs: claimTtlMs } : {}) }),
    ...(signingKey !== undefined ? { privateKey: resolveSigningKey(signingKey) } : {}),
  };
}

/** The payload is hashed in process memory only. Neither it nor any fragment of it reaches a result, log, or audit. */
function digestApprovedPayload(payload: unknown): { packageDigest: string; encoding: typeof PAYLOAD_ENCODING } {
  try { return { packageDigest: digestPayload(payload), encoding: PAYLOAD_ENCODING }; }
  catch (error) {
    if (error instanceof TypeError) throw new ReceiptsError('invalid_payload', 'Approved payloads must be plain JSON values.');
    throw error;
  }
}

function validateReceiptUrl(receiptUrl: string | undefined): void {
  if (receiptUrl === undefined) return;
  let url: URL;
  try { url = new URL(receiptUrl); }
  catch { throw new ReceiptsError('invalid_receipt_url', 'Badge receipt links must be absolute HTTPS URLs without credentials.'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ReceiptsError('invalid_receipt_url', 'Badge receipt links must be absolute HTTPS URLs without credentials.');
  }
}

function buildServer({ audit, connectors, policy, registry, privateKey }: ResolvedConfig): McpServer {
  const server = new McpServer({ name: 'receipts', version: '0.3.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const appendOnly = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const historicalReceipt = (destinationId: string, packageDigest: string, scope?: z.infer<typeof scopeSchema>): Receipt => {
    const receipt = getReceipt(destinationId, packageDigest, audit, scope);
    if (!receipt) throw new ReceiptsError('receipt_not_found', 'No audited complete receipt matches this object, digest, and scope.');
    return receipt;
  };
  const signingKey = (): KeyObject => {
    if (!privateKey) throw new ReceiptsError('signing_key_not_configured', 'Configure a local Ed25519 signing key at startup before requesting signed proofs.');
    return privateKey;
  };
  server.registerTool('receipts.classify', {
    title: 'Classify write evidence',
    description: 'Classify supplied outward-write evidence and return the retry permissions. Pure evaluation; does not observe a provider or persist a receipt.',
    inputSchema: { write: writeSchema },
    annotations: readOnly,
  }, ({ write }) => result(() => classify(write)));
  server.registerTool('receipts.record', {
    title: 'Record caller evidence',
    description: 'Append caller-supplied evidence as host-supplied and independentlyVerified false. Never invent an ID. Use receipts.observe for an independent destination read.',
    inputSchema: { entry: entrySchema },
    annotations: appendOnly,
  }, ({ entry }) => result(() => {
    record(entry, audit);
    return { recorded: true, id: entry.id };
  }));
  server.registerTool('receipts.bind', {
    title: 'Bind object to digest',
    description: 'Bind an existing destination object to its approved digest. Requires a previously audited provider/human observation for that same ID and digest; creates no destination object.',
    inputSchema: identitySchema,
    annotations: appendOnly,
  }, ({ destinationId, packageDigest, scope }) => result(() => bind(destinationId, packageDigest, audit, scope)));
  server.registerTool('receipts.verify', {
    title: 'Verify historical receipt',
    description: 'Verify an ID and digest against the local audit. This does not query a live provider.',
    inputSchema: identitySchema,
    annotations: readOnly,
  }, ({ destinationId, packageDigest, scope }) => result(() => getReceipt(destinationId, packageDigest, audit, scope) ?? { verdict: verify(destinationId, packageDigest, audit, scope), evidenceSource: 'host-supplied', independentlyVerified: false, observedAt: null }));
  for (const recheck of [false,true]) {
    server.registerTool(recheck ? 'receipts.recheck' : 'receipts.observe', {
      title: recheck ? 'Recheck destination' : 'Observe destination',
      description: recheck
        ? 'Read the destination again using a locally configured connector and append the current result; historical receipts are unchanged. A matching read completes a dispatched lease for the same attempt.'
        : 'Read the actual destination with a locally configured connector. Only this server-owned read can issue independentlyVerified evidence. A matching read completes a dispatched lease for the same attempt and returns its admission decision.',
      inputSchema: {request:connectorRequestSchema}, annotations: appendOnly,
    }, ({request}) => result(async () => {
      const connector = connectors.find(item => item.surface === request.surface);
      if (!connector) throw new ReceiptsError('connector_not_configured','Configure this connector locally before requesting an independent read.');
      const receipt = await observeDestination(connector,{...request,recheck} as ConnectorRequest,audit);
      if (receipt.verdict !== 'complete') return receipt;
      // Mirror the SDK: a bound independent read completes the audited lease for this attempt.
      // Legacy or cooperative attempts without a lease are returned unchanged; no lease is invented.
      const attempt = audit.read().find(entry => entry.event === 'attempt' && entry.attemptId === request.attemptId);
      if (!attempt?.registry) return receipt;
      const admission = registry.completeVerified({
        surface: attempt.surface, attemptId: attempt.attemptId, actionId: attempt.actionId!,
        destinationAccount: attempt.destinationAccount!, approvalId: attempt.approvalId!, packageDigest: attempt.packageDigest,
        ...(attempt.idempotencyKey ? { idempotencyKey: attempt.idempotencyKey } : {}),
      }, receipt.destinationId);
      return { ...receipt, admission };
    }));
  }
  server.registerTool('receipts.digest', {
    title: 'Digest approved payload',
    description: 'Compute the digest of the EXACT approved payload once, before any write. Every other tool takes this digest, never the content. The payload is hashed in process memory only and is never logged, persisted, or echoed.',
    inputSchema: { payload: z.unknown() },
    annotations: readOnly,
  }, ({ payload }) => result(() => digestApprovedPayload(payload)));
  server.registerTool('receipts.policy', {
    title: 'Evaluate write policy',
    description: 'Pure pre-check of an approved action against the host-configured policy on the current audit snapshot. Records nothing and consumes no budget; allowed is not a reservation. Policy is startup configuration and cannot be changed by a tool call.',
    inputSchema: { action: approvedActionSchema },
    annotations: readOnly,
  }, ({ action }) => result(() => ({ ...registry.evaluate(action, policy ?? {}), policyConfigured: policy !== undefined })));
  server.registerTool('receipts.claim', {
    title: 'Claim approved action',
    description: 'Reserve the approved action BEFORE writing. CLAIMED returns a fenced lease. DUPLICATE means an execution already exists for this account and action, or the approval is spent: reconcile it with receipts.observe, never write again. policy_denied names the rule and reserves nothing. The returned claim (its token) is the caller\'s authority for receipts.dispatch and receipts.release: do not share, log, or audit it; only its hash is recorded.',
    inputSchema: { action: approvedActionSchema },
    annotations: appendOnly,
  }, ({ action }) => result(() => registry.claim(action, policy ?? {})));
  server.registerTool('receipts.dispatch', {
    title: 'Dispatch claimed write',
    description: 'Durably record, immediately before the outward write, that the write may happen (delivery_unknown until observed) and consume the shared rate budget. After AUTHORIZED perform exactly one write with your own tool, then call receipts.observe with the real locator (or receipts.record, receipts.bind, and receipts.complete). On policy_denied call receipts.release and stop. Never dispatch the same claim twice; a crash after dispatch is uncertain forever until the destination is read back.',
    inputSchema: { claim: claimLeaseSchema },
    annotations: appendOnly,
  }, ({ claim }) => result(() => registry.dispatch(claim, policy ?? {})));
  server.registerTool('receipts.release', {
    title: 'Release unused claim',
    description: 'Release an unused reservation so its approval is free again. Only a claim that was never dispatched can be released; a dispatched claim is a possible write and must be reconciled instead.',
    inputSchema: { claim: claimLeaseSchema },
    annotations: appendOnly,
  }, ({ claim }) => result(() => registry.release(claim)));
  server.registerTool('receipts.complete', {
    title: 'Complete dispatched action',
    description: 'Mark a dispatched action COMPLETED from an audited binding for the exact action and destination. No lease token is needed: the audited dispatch and binding are the authority, so this works after a restart. receipts.observe and receipts.recheck complete leased actions automatically when they bind; use this after the cooperative receipts.record and receipts.bind path, or for recovery.',
    inputSchema: { action: approvedActionSchema, destinationId: text },
    annotations: appendOnly,
  }, ({ action, destinationId }) => result(() => registry.completeVerified(action, destinationId)));
  server.registerTool('receipts.sign', {
    title: 'Sign historical receipt',
    description: 'Opt-in: sign the audited complete receipt for this object and digest with this server\'s local Ed25519 key. The proof embeds the FULL audit snapshot; review it before sharing. Verification needs the public key from a separately trusted source. The signature attests this local signer, not the provider.',
    inputSchema: identitySchema,
    annotations: readOnly,
  }, ({ destinationId, packageDigest, scope }) => result(() => {
    const receipt = historicalReceipt(destinationId, packageDigest, scope);
    return signReceipt(receipt, { store: audit, privateKey: signingKey() });
  }));
  server.registerTool('receipts.badge', {
    title: 'Render verified badge',
    description: 'Render a static HTML badge for an independently verified complete receipt, signed with the local key. Cooperative host-supplied receipts are refused. An optional receiptUrl must be HTTPS without credentials.',
    inputSchema: { ...identitySchema, receiptUrl: text.optional() },
    annotations: readOnly,
  }, ({ destinationId, packageDigest, scope, receiptUrl }) => result(() => {
    const receipt = historicalReceipt(destinationId, packageDigest, scope);
    if (receipt.verdict !== 'complete' || !receipt.independentlyVerified) {
      throw new ReceiptsError('badge_requires_independent_completion', 'Badges require a complete receipt from a locally configured connector read; cooperative receipts are not eligible.');
    }
    const privateKey = signingKey();
    validateReceiptUrl(receiptUrl);
    const proof = signReceipt(receipt, { store: audit, privateKey });
    const badge = renderReceiptBadge(proof, { trustedPublicKey: createPublicKey(privateKey), ...(receiptUrl !== undefined ? { receiptUrl } : {}) });
    return { badge, receiptHash: proof.receiptHash, keyId: proof.signer.keyId, signedAt: proof.signedAt };
  }));
  return server;
}

/** Every server uses the same core contract. Callers supply cooperative evidence; local connectors supply independent observations. */
export function createReceiptsServer(options: ServerOptions = {}): McpServer {
  return buildServer(resolveConfig(options));
}

function rpcError(response: ServerResponse, status: number, code: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}

function isLocalRequest(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  if (request.headers.origin === undefined) return true;
  try {
    const origin = new URL(request.headers.origin);
    return origin.protocol === 'http:' && origin.host === host && origin.origin === request.headers.origin;
  } catch { return false; }
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 1024 * 1024) {
        tooLarge = true;
        chunks.length = 0;
        reject(new RangeError('Request body exceeds 1 MiB.'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
      catch (error) { reject(error); }
    });
  });
}

export interface HttpServerOptions extends ServerOptions { port?: number }

/** Stateless MCP requests, durable core audit, loopback only while v1 has no auth. */
export async function startHttpServer({ port = 3100, ...options }: HttpServerOptions = {}) {
  // Resolve once so an invalid policy, TTL, or key fails before the listener exists.
  const config = resolveConfig(options);
  const active = new Set<McpServer>();
  const httpServer = createServer(async (request, response) => {
    if (!isLocalRequest(request)) {
      rpcError(response, 403, -32000, 'Only same-origin loopback requests are accepted.');
      return;
    }
    if (request.url?.split('?')[0] !== '/mcp') {
      rpcError(response, 404, -32601, 'Use /mcp.');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      rpcError(response, 405, -32000, 'Stateless MCP accepts POST only.');
      return;
    }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      rpcError(response, 415, -32600, 'Content-Type must be application/json.');
      return;
    }
    let body: unknown;
    try { body = await readJson(request); }
    catch (error) {
      rpcError(response, error instanceof RangeError ? 413 : 400, -32700,
        error instanceof RangeError ? error.message : 'Invalid JSON.');
      return;
    }
    const server = buildServer(config);
    active.add(server);
    response.once('close', () => {
      active.delete(server);
      void server.close().catch(() => undefined);
    });
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) rpcError(response, 500, -32603, 'Internal server error.');
      else response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  return {
    server: httpServer,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close(): Promise<void> {
      await Promise.all([...active].map((server) => server.close()));
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    },
  };
}
