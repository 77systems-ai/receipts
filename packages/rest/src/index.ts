import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AddressInfo } from 'node:net';
import {
  bind, classify, record, verify, ReceiptsError,
  type AuditEntry, type AuditStore, type OutwardWrite,
} from '@77systems/receipts-core';

class InputError extends Error {}

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

export interface RestOptions { store?: AuditStore }

/** Thin trusted-local transport. No provider reads, outward writes, or user authentication. */
export function createReceiptsApp({ store }: RestOptions = {}) {
  const app = new Hono();
  app.use('*', async (context, next) => {
    const url = new URL(context.req.url);
    const host = context.req.header('host') ?? url.host;
    const origin = context.req.header('origin');
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)
      || (origin !== undefined && origin !== `http://${host}`)) {
      return context.json({ error: { code: 'forbidden_origin', message: 'Only same-origin loopback requests are accepted.' } }, 403);
    }
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (context) => context.json({
    error: { code: 'body_too_large', message: 'Request body exceeds 1 MiB.' },
  }, 413) }));
  app.use('*', async (context, next) => {
    if (context.req.method === 'POST'
      && context.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return context.json({ error: { code: 'invalid_content_type', message: 'Content-Type must be application/json.' } }, 415);
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
    return context.json(bind(requiredString(data.destinationId, 'destinationId'), requiredString(data.packageDigest, 'packageDigest'), store));
  });
  app.get('/verify', (context) => context.json({ verdict: verify(
    requiredString(context.req.query('destinationId'), 'destinationId'),
    requiredString(context.req.query('packageDigest'), 'packageDigest'), store,
  ) }));
  app.notFound((context) => context.json({ error: { code: 'not_found', message: 'Use POST /classify, /record, /bind or GET /verify.' } }, 404));
  app.onError((error, context) => {
    if (error instanceof SyntaxError || error instanceof InputError) {
      return context.json({ error: { code: 'invalid_input', message: error instanceof SyntaxError ? 'Invalid JSON.' : error.message } }, 400);
    }
    if (error instanceof ReceiptsError) return context.json({ error: { code: error.code, message: error.message } }, 400);
    return context.json({ error: { code: 'internal_error', message: 'Receipts could not complete the operation.' } }, 500);
  });
  return app;
}

export interface RestServerOptions extends RestOptions { port?: number }

export async function startRestServer({ port = 3101, store }: RestServerOptions = {}) {
  const app = createReceiptsApp(store ? { store } : {});
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
