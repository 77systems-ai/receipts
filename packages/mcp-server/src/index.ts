import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  bind, classify, record, verify, ReceiptsError,
  type AuditStore,
} from '@77systems/receipts-core';

const text = z.string().min(1);
const evidenceSchema = z.object({
  source: z.enum(['provider', 'human', 'executor', 'binding']),
  detail: text,
  observedAt: text.optional(),
  destinationId: text.optional(),
  packageDigest: text.optional(),
  reference: text.optional(),
}).strict();

// These are wire shapes only. Digest, surface, evidence, and verdict rules live in core.
const writeSchema = z.object({
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
  event: z.enum(['attempt', 'classification', 'observation', 'binding']),
  evidence: z.array(evidenceSchema),
});
const identitySchema = { destinationId: text, packageDigest: text };

function result(action: () => object): CallToolResult {
  try {
    const value = action();
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

export interface ServerOptions { store?: AuditStore }

/** Every server uses the same core contract. Callers supply trusted adapter evidence. */
export function createReceiptsServer({ store }: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'receipts', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const appendOnly = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  server.registerTool('receipts.classify', {
    description: 'Classify trusted outward-write evidence and return the retry permissions. Pure evaluation; does not observe a provider or persist a receipt.',
    inputSchema: { write: writeSchema },
    annotations: readOnly,
  }, ({ write }) => result(() => classify(write)));
  server.registerTool('receipts.record', {
    description: 'Append a validated audit entry. Observation evidence must come from a trusted adapter or a real human; never invent an ID.',
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
  }, ({ destinationId, packageDigest }) => result(() => bind(destinationId, packageDigest, store)));
  server.registerTool('receipts.verify', {
    description: 'Verify an ID and digest against the local audit. This does not query a live provider.',
    inputSchema: identitySchema,
    annotations: readOnly,
  }, ({ destinationId, packageDigest }) => result(() => ({ verdict: verify(destinationId, packageDigest, store) })));
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
export async function startHttpServer({ port = 3100, store }: HttpServerOptions = {}) {
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
    const server = createReceiptsServer(store ? { store } : {});
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
