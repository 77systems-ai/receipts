import { closeSync, existsSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ReceiptsError, type TrustedConnector, type ConnectorRequest } from '@77systems/receipts-core';
import { digestPayload } from '@77systems/receipts-sdk';

export const FILE_WRITE_SURFACE = 'file-write';
// The 'file-write' surface is registered by @77systems/receipts-core; connectors use it, never re-register it.

export interface FileWritePayload { path: string; content: string }

/** Line-ending normalization shared by the approved payload and the read-back observation. */
export function normalizeFileContent(content: string): string {
  return String(content).replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/** The exact approved-content contract for a file write: the full final file content. */
export function filePayload(path: string, content: string | null): FileWritePayload {
  if (typeof path !== 'string' || !path.trim()) throw new ReceiptsError('invalid_file_payload', 'A file path is required.');
  if (typeof content !== 'string' && content !== null) throw new ReceiptsError('invalid_file_payload', 'File content must be a string.');
  return { path: path.trim(), content: normalizeFileContent(content ?? '') };
}

function fail(code: string, message: string): never { throw new ReceiptsError(code, message); }

export interface FileConnectorOptions {
  /** Local destination account label; must match the claim's destinationAccount. */
  accountId?: string;
  /**
   * Allowed absolute roots; when set, the resolved file must live under one. Falls back to
   * RECEIPTS_FILE_ROOTS (separated by the platform path delimiter) when not provided. Without
   * roots any readable absolute path can be digested; always set them when requests are untrusted.
   */
  roots?: string[];
  /** Largest file the connector will read back. Defaults to 16 MiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Local read-only file connector. It re-reads the written file and digests
 * the exact approved content, so a failed, truncated, or wrong-path write
 * fails the digest match instead of passing silently.
 *
 * Trust note: this connector shares the operator's trust domain (same
 * machine). It proves the write landed as approved; it does not prove
 * independence from the writer the way a remote provider read does.
 */
interface FileReadPolicy { roots?: readonly string[]; maxBytes: number }

/** Validate and realpath the allowed roots, so a symlinked root (for example /tmp on macOS) still admits its own files. */
function readPolicy(options: { roots?: readonly string[]; maxBytes?: number }): FileReadPolicy {
  const envRoots = process.env.RECEIPTS_FILE_ROOTS?.split(delimiter).map((s) => s.trim()).filter(Boolean);
  const configuredRoots = options.roots ?? envRoots;
  if (configuredRoots && (!configuredRoots.length || configuredRoots.some((root) => typeof root !== 'string' || !isAbsolute(root)))) {
    fail('invalid_file_roots', 'Allowed roots must be a nonempty list of absolute paths.');
  }
  const roots = configuredRoots?.map((root) => { try { return realpathSync(root); } catch { return resolve(root); } });
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('invalid_file_roots', 'maxBytes must be a positive integer.');
  return { ...(roots ? { roots } : {}), maxBytes };
}

function withinRoots(real: string, roots: readonly string[] | undefined): boolean {
  return !roots || roots.some((root) => real === root || real.startsWith(root + sep));
}

/** Absolute path check; the given spelling is what the approved payload and destination ID carry. */
function absolutePath(input: unknown, field: string): string {
  if (typeof input !== 'string' || !input.trim()) fail('invalid_locator', `Provide ${field} as an absolute file path.`);
  const given = input.trim();
  if (!isAbsolute(given)) fail('invalid_locator', `${field} must be an absolute path.`);
  return given;
}

/**
 * Read a regular file within the size limit through one descriptor, so the checked file is the read
 * file. Returns undefined content for bytes that are not valid UTF-8; they are never decoded lossily.
 */
function readRegularFile(real: string, maxBytes: number, missing: () => never): { bytes: Buffer; content: string | undefined } {
  let fd: number | undefined;
  try {
    fd = openSync(real, 'r');
    const stat = fstatSync(fd);
    // Only a regular file can be the written object; devices and FIFOs could block or never end.
    if (!stat.isFile()) return fail('object_mismatch', 'The path is not a regular file.');
    if (stat.size > maxBytes) return fail('file_too_large', 'The file exceeds the connector read limit. No verification was issued; do not repeat the write.');
    const bytes = readFileSync(fd);
    let content: string | undefined;
    try { content = utf8.decode(bytes); } catch { content = undefined; }
    return { bytes, content };
  } catch (error) {
    if (error instanceof ReceiptsError) throw error;
    return missing();
  } finally { if (fd !== undefined) closeSync(fd); }
}

export interface StageFileOptions {
  /** Allowed absolute roots for both the staged source and the destination. Falls back to RECEIPTS_FILE_ROOTS. */
  roots?: readonly string[];
  maxBytes?: number;
}

/**
 * Claim from a staged file: read the exact bytes an operator authored at `source` and return the
 * approved payload for writing them to `destination`. Digest this payload, claim it, then write
 * `payload.content` (or copy the unchanged staged file) to the destination. Content is never
 * re-authored between approval and write, so the claimed bytes are the written bytes.
 *
 * Both paths must be absolute and, when roots are configured, inside them; they must differ,
 * because the destination write has to happen after the claim. The source must be a regular
 * UTF-8 text file within the size limit.
 */
export function stageFilePayload(source: string, destination: string, options: StageFileOptions = {}): FileWritePayload {
  const policy = readPolicy(options);
  const sourcePath = absolutePath(source, 'the staged source');
  const destinationPath = absolutePath(destination, 'the destination');
  let real: string;
  try { real = realpathSync(sourcePath); }
  catch { return fail('connector_read_failed', 'The staged file could not be read. Nothing was claimed.'); }
  if (!withinRoots(real, policy.roots)) fail('object_mismatch', 'The staged file is outside the allowed roots.');
  // The destination may not exist yet: resolve its nearest existing ancestor, then append the rest.
  let ancestor = resolve(destinationPath);
  const rest: string[] = [];
  while (!existsSync(ancestor)) { rest.unshift(basename(ancestor)); const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
  const realDestination = join(realpathSync(ancestor), ...rest);
  if (!withinRoots(realDestination, policy.roots)) fail('object_mismatch', 'The destination is outside the allowed roots, so its write could never be read back.');
  if (realDestination === real) fail('invalid_file_payload', 'Stage the content in a different file: the destination write must happen after the claim.');
  const { content } = readRegularFile(real, policy.maxBytes, () => fail('connector_read_failed', 'The staged file could not be read. Nothing was claimed.'));
  if (content === undefined) fail('staged_file_not_text', 'The staged file is not valid UTF-8 text, so it cannot be an approved file payload.');
  return filePayload(destinationPath, content);
}

export function createFileConnector(options: FileConnectorOptions = {}): TrustedConnector {
  const accountId = options.accountId?.trim() || process.env.RECEIPTS_FILE_ACCOUNT?.trim() || 'local:file';
  if (accountId.length > 256 || /[\u0000-\u001f\u007f]/.test(accountId)) fail('invalid_file_account', 'The file connector account id must be a bounded identifier without control characters.');
  const { roots, maxBytes } = readPolicy(options);
  const unreadable = (): never => fail('connector_read_failed', 'The written file could not be read back. No verification was issued; do not repeat the write.');

  function resolvePath(input: unknown): { given: string; real: string } {
    const given = absolutePath(input, 'locator.path');
    let real: string;
    try { real = realpathSync(given); }
    catch { return unreadable(); }
    if (!withinRoots(real, roots)) fail('object_mismatch', 'The file is outside the connector\'s allowed roots.');
    return { given, real };
  }

  return Object.freeze({
    surface: FILE_WRITE_SURFACE,
    async read(request: ConnectorRequest) {
      if (request.destinationAccount !== accountId) fail('account_mismatch', 'The requested destination account does not match this connector.');
      const { given, real } = resolvePath(request.locator?.path);
      // Content exists only in local process memory to compute this digest; the audit holds digests only.
      // Invalid UTF-8 is never decoded with replacement characters (which could collide with approved
      // text). Such a file exists but cannot hold approved text, so it is observed by a byte digest in a
      // shape no approved filePayload can produce.
      const { bytes, content } = readRegularFile(real, maxBytes, unreadable);
      const packageDigest = content === undefined
        ? digestPayload({ path: filePayload(given, '').path, invalidUtf8Sha256: createHash('sha256').update(bytes).digest('hex') })
        : digestPayload(filePayload(given, content));
      return Object.freeze({
        destinationAccount: accountId,
        destinationId: `file:${given}`,
        packageDigest,
        observedAt: new Date().toISOString(),
      });
    },
  });
}
