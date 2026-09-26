import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
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
   * Allowed roots; when set, the resolved file must live under one.
   * Falls back to RECEIPTS_FILE_ROOTS (colon-separated) when not provided.
   */
  roots?: string[];
}

/**
 * Local read-only file connector. It re-reads the written file and digests
 * the exact approved content, so a failed, truncated, or wrong-path write
 * fails the digest match instead of passing silently.
 *
 * Trust note: this connector shares the operator's trust domain (same
 * machine). It proves the write landed as approved; it does not prove
 * independence from the writer the way a remote provider read does.
 */
export function createFileConnector(options: FileConnectorOptions = {}): TrustedConnector {
  const accountId = options.accountId?.trim() || process.env.RECEIPTS_FILE_ACCOUNT?.trim() || 'local:file';
  if (!accountId) fail('invalid_file_account', 'The file connector needs a non-empty account id.');
  const envRoots = process.env.RECEIPTS_FILE_ROOTS?.split(':').map((s) => s.trim()).filter(Boolean);
  const roots = (options.roots ?? envRoots)?.map((root) => resolve(root));
  if (roots && roots.some((root) => !isAbsolute(root))) fail('invalid_file_roots', 'Allowed roots must be absolute paths.');

  function resolvePath(input: unknown): { given: string; real: string } {
    if (typeof input !== 'string' || !input.trim()) fail('invalid_locator', 'Provide locator.path as an absolute file path.');
    const given = input.trim();
    if (!isAbsolute(given)) fail('invalid_locator', 'locator.path must be an absolute path.');
    let real: string;
    try { real = realpathSync(given); }
    catch { return fail('connector_read_failed', 'The written file could not be read back. No verification was issued; do not repeat the write.'); }
    if (roots && !roots.some((root) => real === root || real.startsWith(root + sep))) {
      fail('object_mismatch', 'The file is outside the connector\'s allowed roots.');
    }
    return { given, real };
  }

  return Object.freeze({
    surface: FILE_WRITE_SURFACE,
    async read(request: ConnectorRequest) {
      if (request.destinationAccount !== accountId) fail('account_mismatch', 'The requested destination account does not match this connector.');
      const { given, real } = resolvePath(request.locator?.path);
      let content: string;
      try { content = readFileSync(real, 'utf8'); }
      catch { return fail('connector_read_failed', 'The written file could not be read back. No verification was issued; do not repeat the write.'); }
      // Content exists only in local process memory to compute this digest; the audit holds digests only.
      const packageDigest = digestPayload(filePayload(given, content));
      return Object.freeze({
        destinationAccount: accountId,
        destinationId: `file:${given}`,
        packageDigest,
        observedAt: new Date().toISOString(),
      });
    },
  });
}
