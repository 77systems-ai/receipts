# Receipts MCP

**Verification for every AI agent.** Fifteen tools expose the Receipts core over stdio or Streamable HTTP: evidence, write admission, and signed proofs. Node.js 20+; MIT.

## Run

From this repository, after `npm ci && npm run build`:

```sh
node packages/mcp-server/dist/cli.js
node packages/mcp-server/dist/cli.js --transport http --port 3100
```

The release is configured for the following command after npm publication:

```sh
npx -y @77systems/receipts-mcp
```

A stdio client configuration after publication:

```json
{
  "mcpServers": {
    "receipts": {
      "command": "npx",
      "args": ["-y", "@77systems/receipts-mcp"],
      "env": { "RECEIPTS_AUDIT_PATH": "/absolute/path/receipts/audit.jsonl" }
    }
  }
}
```

Before publication, replace the command with `node` and the arguments with the absolute path to `packages/mcp-server/dist/cli.js` in your checkout.

## Configuration

| Flag | Environment variable | Default | Effect |
| --- | --- | --- | --- |
| `--transport stdio\|http` | | `stdio` | Choose the MCP transport. |
| `--port NUMBER` | | `3100` | HTTP port, 1–65535. |
| `--audit-path FILE` | `RECEIPTS_AUDIT_PATH` | Core default | Append-only audit JSONL shared by cooperating processes. |
| `--policy FILE` | `RECEIPTS_POLICY_PATH` | Permit registered surfaces | JSON `WritePolicy` applied at claim and dispatch. |
| `--claim-ttl MS` | `RECEIPTS_CLAIM_TTL_MS` | Core registry default | TTL for unused reservations, 1 ms to 30 days. |
| `--signing-key FILE` | `RECEIPTS_SIGNING_KEY_PATH` | Signing disabled | PEM PKCS8 Ed25519 private key for `receipts.sign` and `receipts.badge`. |
| `--help` | | | Print usage and exit. |
| | `RECEIPTS_GITHUB_REPO`, `GITHUB_TOKEN` or `GH_TOKEN` | | Enable the GitHub issues connector for `receipts.observe` and `receipts.recheck`. |
| | `RECEIPTS_FILE_ROOTS`, optional `RECEIPTS_FILE_ACCOUNT` | Disabled | Enable the file-write connector. Roots are required over MCP: absolute paths separated by the platform path delimiter; the server reads nothing outside them. The account defaults to `local:file`. |
| | `RECEIPTS_GMAIL_ACCOUNT`, `RECEIPTS_GMAIL_TOKEN` | Disabled | Enable the Gmail send connector with a local OAuth access token that can read the mailbox (`gmail.readonly` is enough). Both are required together. Google access tokens expire, typically after an hour; restart with a fresh token, or embed the connector programmatically with your own refreshing client. |

Flags override environment variables. Files are read once at startup: the policy is parsed and validated, the key is loaded and checked for the Ed25519 type. Any failure writes a `startup_failed` JSON error to stderr and exits nonzero; the message names the path and the failure, never the file contents. A key file readable by other users produces a warning on stderr.

The default audit file is `.receipts/audit.jsonl`, relative to the process working directory. Use an absolute `RECEIPTS_AUDIT_PATH` to share the same audit between clients. The core also maintains `.head` and transient `.lock` sidecars; keep these with the log.

A policy file:

```json
{
  "defaultEffect": "allow",
  "rules": [
    { "id": "blocked-repository", "effect": "block", "destinationAccount": "github:owner/restricted" }
  ],
  "rateLimits": [
    { "id": "issues-per-hour", "surface": "github-issue", "maxWrites": 10, "windowMs": 3600000 }
  ]
}
```

Explicit block rules win. `defaultEffect: "block"` turns the allow rules into an allow-list. Rate budgets count durable dispatches, including uncertain ones, across every client sharing the audit; policy denials consume no budget. Rule IDs are opaque identifiers and appear in audit entries and tool results.

Generate a signing key locally. The private key is written with mode 0600 and never printed; only the public key and its ID are shown:

```sh
node --input-type=module -e "import {writeFileSync} from 'node:fs'; import {generateReceiptKeyPair} from '@77systems/receipts-proof'; const key = generateReceiptKeyPair(); writeFileSync(process.argv[1], key.privateKey, {mode: 0o600, flag: 'wx'}); console.log(key.publicKey); console.log('keyId', key.keyId);" /absolute/path/receipts-signing.pem
```

Distribute the public key and `keyId` to verifiers through a channel you trust separately; a proof carries its own public key only for identification.

Streamable HTTP listens at `http://127.0.0.1:3100/mcp`. It uses stateless requests and JSON responses; audit records persist in the store, and policy, TTL, and key configuration are shared by every request. GET/SSE sessions are not used. The local server has no authentication and deliberately has no remote bind flag. A remote deployment needs a separately operated authenticated gateway and a trusted evidence producer. Host and Origin checks protect the local endpoint from browser-origin misuse; they do not authenticate local clients.

## Tools

Evidence tools:

| Tool | Arguments | Result | Refusals |
| --- | --- | --- | --- |
| `receipts.classify` | `{ "write": OutwardWrite }` | Verdict, retry law, and permission booleans. | `not_a_destination_write`, `invalid_entry` |
| `receipts.record` | `{ "entry": AuditEntry }` | `{ "recorded": true, "id": "…" }` | `action_identity_required`, `invalid_entry` (lifecycle fields are refused earlier by the strict wire schema as an input-validation error) |
| `receipts.bind` | `{ "destinationId", "packageDigest", "scope"? }` | Binding and its audit identifiers. | `observation_required`, `ambiguous_destination` |
| `receipts.verify` | Same identity fields as bind. | Historical receipt with provenance and observation time, or an unverified result. | `ambiguous_destination` |
| `receipts.observe` | `{ "request": ConnectorRequest }` | New independent observation and matching binding using a locally configured connector, plus `admission` when a dispatched lease completes., or `warnings: ["claim_not_dispatched"]` when the action's live reservation was never dispatched (the write bypassed dispatch and its budget; that reservation can no longer dispatch). A request whose attemptId differs from the dispatched attempt is refused with `attempt_mismatch` before any read. | `connector_not_configured`, `connector_read_failed`, `account_mismatch`, `object_mismatch` |
| `receipts.recheck` | Same request shape as observe. | Appended current observation; the original receipt is unchanged. | As observe, plus `observation_required` without a prior receipt |

Admission tools:

| Tool | Arguments | Result | Refusals |
| --- | --- | --- | --- |
| `receipts.digest` | `{ "payload": any JSON value }` | `{ "packageDigest": "sha256:…", "encoding": "receipts-json-v1" }` | `invalid_payload` |
| `receipts.policy` | `{ "action": ApprovedAction }` | `{ "verdict": "allowed" \| "policy_denied", "ruleId"?, "policyConfigured" }` | `not_a_destination_write`, `invalid_entry` |
| `receipts.claim` | `{ "action": ApprovedAction }` | `CLAIMED` with `claim` (the lease, including its token), `DUPLICATE` with `reason`, or `policy_denied` with `ruleId`; each with `auditEntryId`. | `not_a_destination_write`, `invalid_entry`, `audit_busy` |
| `receipts.prepare` | `{ "action": ApprovedAction without packageDigest, "payload"?: unknown, "file"?: { "source", "destination" } }` | `packageDigest`, `encoding`, `policy`, the claim decision (`CLAIMED` with `claim`, `DUPLICATE` with `reason`, or `policy_denied` with `ruleId`), `hint`/`docs` on refusals, `next` after `CLAIMED`, and `destination` for staged files. | `invalid_prepare`, `invalid_payload`, `invalid_file_payload`, `file_staging_not_configured`, `staged_file_not_text`, `object_mismatch` (outside roots), `file_too_large` |
| `receipts.dispatch` | `{ "claim": ClaimLease }` | `AUTHORIZED` or `policy_denied` with `ruleId`. | `stale_claim`, `claim_dispatched`, `claim_expired` |
| `receipts.release` | `{ "claim": ClaimLease }` | `RELEASED`. | `stale_claim`, `claim_dispatched`, `claim_expired` |
| `receipts.complete` | `{ "action": ApprovedAction, "destinationId" }` | `COMPLETED`. | `stale_claim`, `claim_not_dispatched`, `observation_required`, `object_mismatch` |

Proof tools:

| Tool | Arguments | Result | Refusals |
| --- | --- | --- | --- |
| `receipts.sign` | `{ "destinationId", "packageDigest", "scope"? }` | Signed proof: receipt, receipt hash, full audit snapshot, signer key ID and public key, signing time, signature. | `receipt_not_found`, `signing_key_not_configured`, `ambiguous_destination` |
| `receipts.badge` | Same as sign, plus `receiptUrl`? | `{ "badge": "<a…>" \| "<span…>", "receiptHash", "keyId", "signedAt" }` | `receipt_not_found`, `badge_requires_independent_completion`, `signing_key_not_configured`, `invalid_receipt_url` |

`ApprovedAction` is `{ surface, attemptId, actionId, destinationAccount, approvalId, packageDigest, idempotencyKey? }`: the caller's UUID action, exact account, explicit approval, and the digest from `receipts.digest`. `ClaimLease` is the `claim` object returned by `receipts.claim`, passed back unchanged. These are wire shapes; identity, fencing, and policy semantics belong to the core registry.

For example, call `receipts.classify` with:

```json
{
  "write": {
    "surface": "social-publish",
    "attemptId": "attempt-1",
    "packageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "writeMayHaveHappened": true
  }
}
```

This deliberately fictional digest is for demonstration. The result is `delivery_unknown`, with `mayAutoRetry`, `maySecondWrite`, and `mayRearm` all false. In a real integration, compute the digest from the exact approved payload with `receipts.digest` or the SDK.

## Guarded write sequence

New here? Start with [the 5-minute quickstart](../../docs/QUICKSTART.md): one staged file, five calls, first verified receipt. The loop below is the whole product — learn it first; everything else in the tool list is for advanced cases.

A guarded, verified write is five steps, four of them Receipts calls:

1. `receipts.prepare` with the approved action and exactly one of `payload` (the exact approved JSON) or `file` (`{ source, destination }`, file-write only). It digests, evaluates policy, and claims in one call. With `file`, the server reads the staged file and claims its exact bytes for `destination`, so content cannot be re-authored between approval and write. `DUPLICATE` carries its reason and a hint (reconcile, wait, or obtain a new approval); `policy_denied` reserves nothing. `receipts.digest`, `receipts.policy`, and `receipts.claim` remain available as separate steps.
2. `receipts.dispatch` with the returned claim, immediately before the write. `AUTHORIZED` durably records that the write may happen and consumes the shared budget. `policy_denied` means the budget moved between claim and dispatch: call `receipts.release` and stop.
3. Perform exactly one outward write with your own tool; after a staged `prepare`, copy the staged file to `destination` byte-for-byte. Never dispatch the same claim twice. A crash after dispatch is uncertain until the destination is read back; the lease never expires into another write.
4. `receipts.observe` with the real locator or object ID and the same attemptId. A matching independent read binds the object and completes the lease, returning `admission.verdict: "COMPLETED"`. Without a connector, `receipts.record` the observation, `receipts.bind`, then `receipts.complete`.
5. `receipts.sign` or `receipts.badge` when a shareable proof is required and a key is configured.

That is five steps for a guarded, verified, signed write, four of them Receipts calls. Observe and sign stay separate because they must happen after the write. A non-complete observe or recheck result carries `hint` and `docs`: `package_unverified` means the bytes written differ from the claimed bytes, so claim from the staged file next time instead of re-authoring the content.

The remaining tools are for advanced cases — reach for them after the loop above is working:

`classify` evaluates supplied evidence without I/O. `record` always labels caller observations host-supplied with independentlyVerified false, including forged provider/trust flags. `bind` requires an audited exact object/package observation and inherits its provenance. `verify` inspects history without refreshing it.

`observe` and `recheck` use trusted executable connectors installed locally at startup. Set `RECEIPTS_GITHUB_REPO=owner/repo` and a local GITHUB_TOKEN or GH_TOKEN to enable GitHub (locator `{issueNumber:42}`), `RECEIPTS_FILE_ROOTS` to enable file-write read-back (locator `{path:"/absolute/path"}`), or `RECEIPTS_GMAIL_ACCOUNT` with `RECEIPTS_GMAIL_TOKEN` to enable Gmail send read-back (locator `{messageId:"…"}`). A half-configured connector, or file read-back without roots, fails startup. Request fields are surface, attemptId, actionId (UUID), destinationAccount, approvalId, packageDigest, and either destinationId or locator (GitHub: `{issueNumber:42}`). Credentials never appear in tool arguments or audit entries. New record entries also require action/account/approval identity. When the request's attempt was dispatched through `receipts.dispatch`, a complete read also completes that lease; attempts without a lease are returned unchanged and gain no invented admission decision.

`receipts.complete` needs no token: the audited dispatch and binding are its authority, so recovery works after a restart. `receipts.badge` renders only independently verified complete receipts; cooperative receipts can be signed, and the proof shows `host-supplied`.

A programmatic server can pass `{ store, connectors, policy, claimTtlMs, signingKey, fileRoots }`; `fileRoots` (from `RECEIPTS_FILE_ROOTS` in the CLI) enables staged-file claims and must cover both the staging and destination directories. A remote caller cannot install connectors, supply a read result, or change the policy. A changed-content read is independently observed but remains package_unverified. `bind`/`verify`/`sign`/`badge` accept an optional scope with account/action/surface/attempt to disambiguate historical records.

## Client library

`@77systems/receipts-mcp/client` is a Node client for this server that cannot hang. It launches the server (this package's CLI by default, or any `command`/`args`) or reaches a Streamable HTTP `url`. It completes the handshake and races every call against a deadline, 60 seconds by default and configurable with `timeoutMs`. When the deadline passes, the client stops the server process and throws `client_timeout`, naming the tool and stating that the call returned no receipt. A server that exits mid-call produces `client_disconnected`. Responses split across any number of pipe reads are reassembled by the official MCP transport before parsing.

```ts
import { connectReceipts } from '@77systems/receipts-mcp/client';

const receipts = await connectReceipts({ env: { RECEIPTS_FILE_ROOTS: '/srv/receipts', RECEIPTS_AUDIT_PATH: '/srv/receipts/audit.jsonl' } });
try {
  const prepared = await receipts.prepare({ action, file: { source: '/srv/receipts/staging/memo.md', destination: '/srv/receipts/out/memo.md' } });
  if (prepared.verdict !== 'CLAIMED') throw new Error(String(prepared.hint));
  await receipts.dispatch(prepared.claim as Record<string, unknown>);
  await copyFile('/srv/receipts/staging/memo.md', '/srv/receipts/out/memo.md');
  const receipt = await receipts.observe({ ...action, packageDigest: prepared.packageDigest, locator: { path: '/srv/receipts/out/memo.md' } });
} finally { await receipts.close(); }
```

Tool refusals throw `ReceiptsToolError` with `tool`, `code`, `message`, `hint`, and `docs`. After a timeout or disconnect, do not repeat an outward write: reconnect and read the audit (`verify`, `observe`, or a claim that reports `DUPLICATE` with reason `dispatched`) to learn what was recorded.

## Security notes

- The lease token returned by `receipts.claim` is the caller's authority for dispatch and release. Only its hash is audited. Keep it out of evidence, reports, logs, and shared context.
- Policy, claim TTL, and the signing key are host-owned startup configuration. No tool call can read or change them; `receipts.policy` only reports the decision for one action.
- The server records that a write was authorized. It cannot prove that the write was performed, or performed once, after dispatch: only a destination read can. Wire tools cannot force an agent to dispatch before writing; the SDK wrapper enforces the order in code.
- A signed proof embeds the full local audit snapshot and attests this server's local key, not the provider. Verifiers need the public key from a separately trusted source. Review a proof before sharing it.
- Hosted deployments need a separately secured gateway. This server authenticates nobody.

## Support CLI

The `receipts` executable (`node packages/mcp-server/dist/receipts.js` from source) carries two support commands. Neither prints credential values, payloads, identifiers, digests, or file paths.

`receipts doctor` checks Node, actual MCP boot, the full tool list, and credential presence, rendered for people with a nonzero exit when a check fails. `receipts doctor --json` prints the same report as `{ ok, version, checks: [{ name, ok, detail }] }` with nothing else on stdout, so it can be piped into scripts. It makes no destination request.

`receipts bug-report` assembles a redacted support bundle and prints it as a Markdown issue body: package versions, Node and platform, which configuration variables are present (never their values), the doctor checks, and the audit's health (entry count, head checkpoint, chain validity as `valid` or an error code) with a shape-only tail of recent entries (sequence, timestamp, event, verdict, admission verdict, evidence source, surface). Accounts, action and attempt identifiers, digests, evidence, lease metadata, and the audit path itself are omitted, and any configured value that somehow appears is replaced with `[redacted]`. `--url` prints a prefilled GitHub new-issue link, `--open` opens it in a browser, `--json` prints the bundle, `--audit-path FILE`, `--tail N` (0 disables the table), and `--no-doctor` adjust what is collected. Nothing is submitted or uploaded; you review the form before creating the issue.

Every tool error envelope names a documented code with a `hint` and `docs` link from the [error taxonomy](../../docs/ERRORS.md).
Failures from core return `isError: true` with `{ "error": { "code": "…", "message": "…" } }` as text and structured content. Invalid tool argument shapes produce an MCP input-validation error. Unknown surfaces return `not_a_destination_write`; there is no fifth verdict. HTTP rejects invalid content types, bodies over 1 MiB, invalid JSON, foreign Host headers, and cross-origin requests. Startup failures write a JSON error to stderr and exit nonzero. Stdout is reserved for MCP in stdio mode.

## Extend and test

Custom surfaces are registered in process with core `registerSurface` before calling the exported `createReceiptsServer` or `startHttpServer`. A surface's `observe` callback is invoked by your integration, never by these tools. Supply a custom synchronous `AuditStore` through the factory's `{ store, connectors }` options.

```sh
npm run build
npm test --workspace @77systems/receipts-mcp
```

Tests use official MCP clients against both a real stdio subprocess and a local HTTP listener, including an uncertain write resolved by observation and binding, guarded claim/dispatch/complete flows with duplicate, forged-token, and budget refusals, policy and signing-key configuration through CLI flags, and offline verification of signed proofs. Transport implementation follows the [official TypeScript SDK server guide](https://ts.sdk.modelcontextprotocol.io/server).
