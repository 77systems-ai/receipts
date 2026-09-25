import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  bind, classify, record, verify, getReceipt, observeDestination, ReceiptsError,
  type AuditStore, type TrustedConnector, type ConnectorRequest,
} from '@77systems/receipts-core';

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
export const RECEIPTS_TOOL_NAMES = ['receipts.classify','receipts.record','receipts.bind','receipts.verify','receipts.observe','receipts.recheck'] as const;


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

export interface ServerOptions { store?: AuditStore; connectors?: readonly TrustedConnector[] }

/** Every server uses the same core contract. Callers supply cooperative evidence; local connectors supply independent observations. */
export function createReceiptsServer({ store, connectors = [] }: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'receipts', version: '0.3.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const appendOnly = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  server.registerTool('receipts.classify', {
    description: 'Classify supplied outward-write evidence and return the retry permissions. Pure evaluation; does not observe a provider or persist a receipt.',
    inputSchema: { write: writeSchema },
    annotations: readOnly,
  }, ({ write }) => result(() => classify(write)));
  server.registerTool('receipts.record', {
    description: 'Append caller-supplied evidence as host-supplied and independentlyVerified false. Never invent an ID. Use receipts.observe for an independent destination read.',
    inputSchema: { entry: entrySchema },
    annotations: appendOnly,
  }, ({ entry }) => result(() => {
    record(entry, store);
    return { recorded: true, id: entry.id };
  }));
  server.registerTool('receipts.bind', {
    description: 'Bind an existing destination object to its approved digest. Requires a previously audited provider/human observation for that same ID and digest; creates no destination object.',
    inputSchema: identitySchema,
    annotations: appendOnly,
  }, ({ destinationId, packageDigest, scope }) => result(() => bind(destinationId, packageDigest, store, scope)));
  server.registerTool('receipts.verify', {
    description: 'Verify an ID and digest against the local audit. This does not query a live provider.',
    inputSchema: identitySchema,
    annotations: readOnly,
  }, ({ destinationId, packageDigest, scope }) => result(() => getReceipt(destinationId, packageDigest, store, scope) ?? { verdict: verify(destinationId, packageDigest, store, scope), evidenceSource: 'host-supplied', independentlyVerified: false, observedAt: null }));
  for (const recheck of [false,true]) {
    server.registerTool(recheck ? 'receipts.recheck' : 'receipts.observe', {
      description: recheck ? 'Read the destination again using a locally configured connector and append the current result; historical receipts are unchanged.' : 'Read the actual destination with a locally configured connector. Only this server-owned read can issue independentlyVerified evidence.',
      inputSchema: {request:connectorRequestSchema}, annotations: appendOnly,
    }, ({request}) => result(async () => {
      const connector = connectors.find(item => item.surface === request.surface);
      if (!connector) throw new ReceiptsError('connector_not_configured','Configure this connector locally before requesting an independent read.');
      return observeDestination(connector,{...request,recheck} as ConnectorRequest,store);
    }));
  }
  return server;
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
export async function startHttpServer({ port = 3100, store, connectors }: HttpServerOptions = {}) {
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
    const server = createReceiptsServer({store,connectors});
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
