# @77systems/receipts-file

Local read-back file connector for Receipts. Requires Node 20+. No credentials; it reads only absolute paths, optionally restricted to allowed roots. The connector never modifies files.

```ts
import {createFileConnector, filePayload} from '@77systems/receipts-file';
import {observeDestination} from '@77systems/receipts-core';
import {digestPayload} from '@77systems/receipts-sdk';
import {randomUUID} from 'node:crypto';

const payload=filePayload('/var/receipts/brief.md', approvedMarkdown);
const receipt=await observeDestination(createFileConnector({roots:['/var/receipts']}),{
  surface:'file-write',attemptId:randomUUID(),actionId:randomUUID(),approvalId:randomUUID(),
  destinationAccount:'local:file',packageDigest:digestPayload(payload),
  locator:{path:'/var/receipts/brief.md'}, // The exact path that was written.
});
```

For guarded writes, use the SDK with the connector configured and reconcile the original attempt instead of generating new action identities. See the root README.

The connector re-reads the file and digests `filePayload(path, content)` — the full final content, with `\r\n` normalized to `\n` and trailing newlines stripped. A failed, truncated, or wrong-path write fails the digest match instead of passing silently. Content is decoded as strict UTF-8: a file that is not valid UTF-8 is observed by a byte digest that can never equal approved text (it records placement as `package_unverified`, never `complete`), and a byte-order mark is kept rather than silently dropped. Only regular files up to `maxBytes` (16 MiB by default) are read; directories, devices, and FIFOs fail with `object_mismatch`, larger files with `file_too_large`.

Reads are resolved with `realpath`, and so are the roots, so a symlink cannot smuggle a file past them while a symlinked root (such as `/tmp` on macOS) still admits its own files. When `roots` is set (or `RECEIPTS_FILE_ROOTS` is configured, separated by the platform path delimiter), a file outside the roots is rejected with `object_mismatch`; relative or empty roots fail with `invalid_file_roots`; a missing or unreadable file fails closed with `connector_read_failed`. **Set roots whenever the path comes from an untrusted caller.** Without them the connector will digest any readable absolute path, which lets a caller test guesses about local file contents. The MCP server refuses to enable the connector without `RECEIPTS_FILE_ROOTS`. The destination account defaults to `local:file` and can be set explicitly or via `RECEIPTS_FILE_ACCOUNT`. Caller evidence labels cannot invoke this connector or mint its provenance.

Trust note, stated plainly: this connector shares the operator's trust domain — it runs on the same machine that performed the write. It proves the write landed exactly as approved, which catches the common agent failure of claiming a save that never happened. It does not prove independence from the writer the way a remote provider read does.

Content exists only in local process memory to compute the digest; the audit holds digests only, never file contents.

Tests run the public Receipts conformance suite plus file-specific path-validation, roots-enforcement, symlinked-root, strict-UTF-8, regular-file, size-limit, and normalization cases.
