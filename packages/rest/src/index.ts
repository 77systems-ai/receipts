import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AddressInfo } from 'node:net';
import {
  bind, classify, record, verify, getReceipt, observeDestination, describeError, ReceiptsError,
  type AuditEntry, type AuditStore, type OutwardWrite, type TrustedConnector, type ConnectorRequest, type ReceiptScope,
} from '@77systems/receipts-core';

class InputError extends Error {}

/** Every envelope names a documented code; the hint and link come from the taxonomy, never from input. */
function failure(code: string, message: string) {
  const entry = describeError(code);
  return { error: { code, message, ...(entry ? { hint: entry.fix, docs: entry.docs } : {}) } };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected a JSON object.');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new InputError(`${field} must be a non-empty string.`);
  return value;
}

function writeInput(value: unknown): OutwardWrite {
  const data = object(value);
  for (const field of ['surface', 'attemptId', 'packageDigest']) requiredString(data[field], field);
  return data as unknown as OutwardWrite;
}

function entryInput(value: unknown): AuditEntry {
  const data = object(value);
  writeInput(data);
  for (const field of ['id', 'timestamp', 'verdict', 'event']) requiredString(data[field], field);
  if (!Array.isArray(data.evidence)) throw new InputError('evidence must be an array.');
  return data as unknown as AuditEntry;
}

function scopeInput(value: unknown): ReceiptScope | undefined {
  if (value === undefined) return undefined;
  const data = object(value);
  const scope: ReceiptScope = {};
  for (const key of ['destinationAccount','actionId','surface','attemptId'] as const) {
    if (data[key] !== undefined) scope[key] = requiredString(data[key],key);
  }
  return scope;
}

function connectorInput(data: Record<string, unknown>): ConnectorRequest {
  const request: ConnectorRequest = {
    surface: requiredString(data.surface,'surface'), attemptId: requiredString(data.attemptId,'attemptId'),
    actionId: requiredString(data.actionId,'actionId'), destinationAccount: requiredString(data.destinationAccount,'destinationAccount'),
    approvalId: requiredString(data.approvalId,'approvalId'), packageDigest: requiredString(data.packageDigest,'packageDigest'),
  };
  if (data.destinationId !== undefined) request.destinationId = requiredString(data.destinationId,'destinationId');
  if (data.locator !== undefined) {
    const locator = object(data.locator);
    if (Object.values(locator).some(value => typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))) throw new InputError('Locator values must be strings or numbers.');
    request.locator = locator as Record<string,string|number>;
  }
  return request;
}

export interface RestOptions { store?: AuditStore; connectors?: readonly TrustedConnector[] }

/** Loopback-only transport; independent reads use connectors configured locally at startup. */
export function createReceiptsApp({ store, connectors = [] }: RestOptions = {}) {
  const app = new Hono();
  app.use('*', async (context, next) => {
    const url = new URL(context.req.url);
    const host = context.req.header('host') ?? url.host;
    const origin = context.req.header('origin');
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)
      || (origin !== undefined && origin !== `http://${host}`)) {
      return context.json(failure('forbidden_origin', 'Only same-origin loopback requests are accepted.'), 403);
    }
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (context) => context.json(failure('body_too_large', 'Request body exceeds 1 MiB.'), 413) }));
  app.use('*', async (context, next) => {
    if (context.req.method === 'POST'
      && context.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return context.json(failure('invalid_content_type', 'Content-Type must be application/json.'), 415);
    }
    await next();
  });
  app.post('/classify', async (context) => context.json(classify(writeInput(await context.req.json()))));
  app.post('/record', async (context) => {
    const entry = entryInput(await context.req.json());
    record(entry, store);
    return context.json({ recorded: true, id: entry.id }, 201);
  });
  app.post('/bind', async (context) => {
    const data = object(await context.req.json());
    return context.json(bind(requiredString(data.destinationId, 'destinationId'), requiredString(data.packageDigest, 'packageDigest'), store, scopeInput(data.scope)));
  });
  app.get('/verify', (context) => {
    const id = requiredString(context.req.query('destinationId'), 'destinationId');
    const digest = requiredString(context.req.query('packageDigest'), 'packageDigest');
    const scope = { destinationAccount: context.req.query('destinationAccount'), actionId: context.req.query('actionId') };
    return context.json(getReceipt(id, digest, store, scope) ?? {
      verdict: verify(id, digest, store, scope), evidenceSource: 'host-supplied', independentlyVerified: false, observedAt: null,
    });
  });
  for (const recheck of [false,true]) {
    app.post(recheck ? '/recheck' : '/observe', async (context) => {
      const data=object(await context.req.json());
      const request = connectorInput(data);
      const connector=connectors.find(item=>item.surface===data.surface);
      if(!connector) throw new ReceiptsError('connector_not_configured','Configure this connector locally before requesting an independent read.');
      return context.json(await observeDestination(connector,{...request,recheck},store));
    });
  }
  app.notFound((context) => context.json(failure('not_found', 'Use POST /classify, /record, /bind, /observe, /recheck or GET /verify.'), 404));
  app.onError((error, context) => {
    if (error instanceof SyntaxError || error instanceof InputError) {
      return context.json(failure('invalid_input', error instanceof SyntaxError ? 'Invalid JSON.' : error.message), 400);
    }
    if (error instanceof ReceiptsError) return context.json(failure(error.code, error.message), 400);
    return context.json(failure('internal_error', 'Receipts could not complete the operation.'), 500);
  });
  return app;
}

export interface RestServerOptions extends RestOptions { port?: number }

export async function startRestServer({ port = 3101, store, connectors }: RestServerOptions = {}) {
  const app = createReceiptsApp({store,connectors});
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return {
    app,
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
