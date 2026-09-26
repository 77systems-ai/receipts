import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ReceiptsError } from '@77systems/receipts-core';
import type { ReceiptsToolName } from './tools.js';
import { PACKAGE_VERSION } from './version.js';

export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ConnectOptions {
  /** Launcher for a stdio server. Defaults to this package's own CLI under the current Node. */
  command?: string;
  args?: string[];
  /** Added to the current environment for the launched server (RECEIPTS_AUDIT_PATH, RECEIPTS_FILE_ROOTS, ...). */
  env?: Record<string, string>;
  cwd?: string;
  /** Where the launched server's stderr goes. Defaults to inherit, so startup failures are visible. */
  stderr?: 'inherit' | 'pipe' | 'ignore';
  /** Connect to a running Streamable HTTP server instead of launching one. */
  url?: string | URL;
  /** Deadline for the handshake and every call, in milliseconds. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/** A tool refused the call. code, message, hint, and docs come from the error taxonomy. */
export class ReceiptsToolError extends ReceiptsError {
  constructor(readonly tool: string, code: string, message: string) {
    super(code, message);
    this.name = 'ReceiptsToolError';
  }
}

const timedOut = Symbol('timed out');

/**
 * A Receipts MCP client that cannot hang. Framing is handled by the official transport, which
 * buffers across pipe reads, so a response split over any number of chunks still parses. Every
 * handshake and call races a deadline: on expiry the client stops the server process (SIGTERM,
 * then SIGKILL) and throws client_timeout naming the tool, so an operator never waits on silence.
 */
export class ReceiptsMcpClient {
  readonly #client: Client;
  readonly #transport: StdioClientTransport | StreamableHTTPClientTransport;
  readonly #timeoutMs: number;
  #closed = false;

  private constructor(client: Client, transport: StdioClientTransport | StreamableHTTPClientTransport, timeoutMs: number) {
    this.#client = client;
    this.#transport = transport;
    this.#timeoutMs = timeoutMs;
  }

  /** Launch (or reach) a server and complete the MCP handshake within the deadline. */
  static async connect(options: ConnectOptions = {}): Promise<ReceiptsMcpClient> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new ReceiptsError('invalid_input', 'timeoutMs must be a positive integer number of milliseconds.');
    const transport = options.url !== undefined
      ? new StreamableHTTPClientTransport(new URL(options.url))
      : new StdioClientTransport({
        command: options.command ?? process.execPath,
        args: options.args ?? (options.command ? [] : [fileURLToPath(new URL('./cli.js', import.meta.url))]),
        env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ...options.env },
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stderr: options.stderr ?? 'inherit',
      });
    const client = new ReceiptsMcpClient(new Client({ name: '@77systems/receipts-mcp-client', version: PACKAGE_VERSION }), transport, timeoutMs);
    await client.#deadline('initialize', timeoutMs, (signal) => client.#client.connect(transport, { signal, timeout: timeoutMs + 5_000 }));
    return client;
  }

  /** Operating-system process id of a launched stdio server, or null. */
  get pid(): number | null { return this.#transport instanceof StdioClientTransport ? this.#transport.pid : null; }
  get closed(): boolean { return this.#closed; }

  /**
   * Call a Receipts tool. Resolves with its structured result; throws ReceiptsToolError when the tool
   * refuses, client_timeout when the deadline passes, and client_disconnected when the server exits.
   */
  async call(tool: ReceiptsToolName, args: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const result = await this.#deadline(tool, timeoutMs, (signal) =>
      this.#client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: timeoutMs + 5_000 }));
    const structured = (result.structuredContent ?? parseText(result.content)) as Record<string, unknown>;
    if (result.isError) {
      const error = (structured?.error ?? {}) as { code?: unknown; message?: unknown };
      throw new ReceiptsToolError(tool, typeof error.code === 'string' ? error.code : 'internal_error',
        typeof error.message === 'string' ? error.message : 'Receipts could not complete the operation.');
    }
    return structured;
  }

  /** Digest, policy, and claim in one call: `{ action, payload }` or `{ action, file: { source, destination } }`. */
  prepare(input: { action: Record<string, unknown>; payload?: unknown; file?: { source: string; destination: string } }) { return this.call('receipts.prepare', input); }
  dispatch(claim: Record<string, unknown>) { return this.call('receipts.dispatch', { claim }); }
  release(claim: Record<string, unknown>) { return this.call('receipts.release', { claim }); }
  observe(request: Record<string, unknown>) { return this.call('receipts.observe', { request }); }
  recheck(request: Record<string, unknown>) { return this.call('receipts.recheck', { request }); }
  verify(identity: { destinationId: string; packageDigest: string; scope?: Record<string, string> }) { return this.call('receipts.verify', identity); }
  sign(identity: { destinationId: string; packageDigest: string; scope?: Record<string, string> }) { return this.call('receipts.sign', identity); }

  /** Stop the server (for stdio: SIGTERM, then SIGKILL) and refuse further calls. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close().catch(() => undefined);
    await this.#transport.close().catch(() => undefined);
  }

  async #deadline<T>(label: string, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed) throw new ReceiptsError('client_closed', 'This Receipts client is closed. Create a new client and read the audit before continuing.');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); });
    try {
      const outcome = await Promise.race([operation(controller.signal), deadline]);
      if (outcome !== timedOut) return outcome as T;
      controller.abort();
      await this.close();
      throw new ReceiptsError('client_timeout', `${label} did not answer within ${timeoutMs} ms. The Receipts server was stopped and this call returned no receipt. Do not repeat an outward write; reconnect and read the audit to learn what was recorded.`);
    } catch (error) {
      if (error instanceof ReceiptsError) throw error;
      // The server exited, closed the pipe, or could not be launched: never leave the caller waiting.
      await this.close();
      if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed && error.code !== ErrorCode.RequestTimeout) throw error;
      throw new ReceiptsError('client_disconnected', `The Receipts server stopped before ${label} answered. This call returned no receipt. Check the server's stderr, reconnect, and read the audit before acting; do not repeat an outward write.`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function parseText(content: unknown): unknown {
  const first = Array.isArray(content) ? content.find((item: { type?: string }) => item?.type === 'text') as { text?: string } | undefined : undefined;
  if (!first?.text) return {};
  try { return JSON.parse(first.text); } catch { return {}; }
}

/** Launch or reach a Receipts MCP server. See ConnectOptions. */
export function connectReceipts(options: ConnectOptions = {}): Promise<ReceiptsMcpClient> {
  return ReceiptsMcpClient.connect(options);
}
