# Receipts REST

**Verification for every AI agent.** A thin Hono wrapper gives non-JavaScript integrations the same Receipts core contract. Node.js 20+; MIT.

## Run

From this repository, after `npm ci && npm run build`:

```sh
node packages/rest/dist/cli.js --port 3101
```

After npm publication:

```sh
npx -y @77systems/receipts-rest --port 3101
```

The server listens only on `127.0.0.1`. Flags are `--port NUMBER` (default `3101`, range 1–65535), `--audit-path FILE`, and `--help`. `--audit-path` overrides `RECEIPTS_AUDIT_PATH`; otherwise core defaults to `.receipts/audit.jsonl` in the working directory. Use an absolute path for a shared audit. Keep the log's `.head` checkpoint and `.lock` sidecars with it.

Requests are stateless; the audit is durable. There is no user-account or authentication service. Use this API only between trusted local processes. A public deployment requires its own authenticated gateway and trusted provider adapters. Host and Origin checks do not authenticate local callers.

## Contract

| Endpoint | Input | Response |
| --- | --- | --- |
| `POST /classify` | `OutwardWrite` JSON body | Classification with verdict and permission booleans. |
| `POST /record` | `AuditEntry` JSON body | `201` and `{ "recorded": true, "id": "…" }` |
| `POST /bind` | `{ "destinationId": "…", "packageDigest": "sha256:…" }` | Binding and its audit identifiers. |
| `GET /verify` | `destinationId`, `packageDigest`, optional `destinationAccount`, `actionId` | Original receipt with source/time, or unverified result. |
| `POST /observe` | `ConnectorRequest` JSON body | Independent read and matching binding. |
| `POST /recheck` | Same request shape as observe | Appended current result; original receipt unchanged. |

Try a fictional uncertain write:

```sh
curl -sS http://127.0.0.1:3101/classify \
  -H 'Content-Type: application/json' \
  -d '{"surface":"http-post","attemptId":"attempt-1","packageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","writeMayHaveHappened":true}'
```

The result is `delivery_unknown`; all three permissions are false. The demonstration digest is fictional. Use the SHA-256 digest of the exact approved payload in a real integration.

For independent GitHub reads, set `RECEIPTS_GITHUB_REPO=owner/repo` and a local GITHUB_TOKEN or GH_TOKEN before starting. POST /observe with surface, attemptId, actionId (UUID), destinationAccount, approvalId, packageDigest, and a real destinationId or locator (`{issueNumber:42}`). Recheck uses the same identity and requires an existing receipt. Credentials are startup configuration, never request fields.

The permanent cooperative path accepts observations through /record, labels them host-supplied and independentlyVerified false, then binds them through /bind. Forged provider/trust flags cannot make them independent. New audit entries require action/account/approval fields. Bind supports an optional `scope` object; use exact account/action scope when object identities are ambiguous.

Classify is pure and records no proof. Verify reads existing history and does not refresh observation time. Observe/recheck perform provider reads only through locally configured connector code, never a caller-supplied implementation. No endpoint performs an outward provider write.
Errors use `{ "error": { "code": "…", "message": "…" } }`. Input or core validation errors return `400`, foreign Host/Origin requests `403`, unknown routes `404`, oversized bodies `413`, non-JSON POSTs `415`, and unexpected server errors `500`. Unknown surfaces use `not_a_destination_write` as an error code, not a verdict. JSON bodies are limited to 1 MiB. Startup failures write a JSON error to stderr and exit nonzero.

## Embed

```ts
import { JsonlAuditStore, registerSurface } from '@77systems/receipts-core';
import { createReceiptsApp, startRestServer } from '@77systems/receipts-rest';

registerSurface({ name: 'ticket-create', idPattern: /^ticket-[0-9]+$/ });
const store = new JsonlAuditStore('/absolute/path/receipts/audit.jsonl');
const running = await startRestServer({ store, port: 3101 });
// Later: await running.close();
// createReceiptsApp({ store, connectors: [] }) exposes a Hono app for a controlled integration.
```

Registration and connector configuration belong to trusted application code. Pass `connectors: [connector]` to configure programmatic readers. The transport does not provide an endpoint to alter the surface registry.

```sh
npm run build
npm test --workspace @77systems/receipts-rest
```

Tests run the full uncertainty → observation → binding → verification flow through a real HTTP listener and check malformed input and local HTTP safeguards. The listener uses the [official Hono Node adapter](https://hono.dev/docs/getting-started/nodejs).
