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

Requests are stateless; the audit is durable. There are no accounts or authentication in v1. Use this API only between trusted local processes. A public deployment requires its own authenticated gateway and trusted provider adapters. Host and Origin checks do not authenticate local callers.

## Contract

| Endpoint | Input | Response |
| --- | --- | --- |
| `POST /classify` | `OutwardWrite` JSON body | Classification with verdict and permission booleans. |
| `POST /record` | `AuditEntry` JSON body | `201` and `{ "recorded": true, "id": "…" }` |
| `POST /bind` | `{ "destinationId": "…", "packageDigest": "sha256:…" }` | Binding and its audit identifiers. |
| `GET /verify` | `destinationId` and `packageDigest` query parameters | `{ "verdict": "…" }` |

Try a fictional uncertain write:

```sh
curl -sS http://127.0.0.1:3101/classify \
  -H 'Content-Type: application/json' \
  -d '{"surface":"http-post","attemptId":"attempt-1","packageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","writeMayHaveHappened":true}'
```

The result is `delivery_unknown`; all three permissions are false. The demonstration digest is fictional. Use the SHA-256 digest of the exact approved payload in a real integration.

To resolve uncertainty, a trusted adapter or operator first finds the existing object and confirms its package. Append an `observation` audit entry containing that evidence, then call `/bind` with the same ID and digest, then `/verify`. `/bind` will fail without the prior matching observation. This sequence never calls the destination writer again.

`classify` evaluates supplied evidence without I/O; it does not establish its authenticity or persist a receipt. `record` checks schema and core consistency before appending. `bind` and `verify` use the audit. None of these endpoints reads a provider or proves that arbitrary client JSON is truthful. Models must never invent destination IDs or observation evidence.

Errors use `{ "error": { "code": "…", "message": "…" } }`. Input or core validation errors return `400`, foreign Host/Origin requests `403`, unknown routes `404`, oversized bodies `413`, non-JSON POSTs `415`, and unexpected server errors `500`. Unknown surfaces use `not_a_destination_write` as an error code, not a verdict. JSON bodies are limited to 1 MiB. Startup failures write a JSON error to stderr and exit nonzero.

## Embed

```ts
import { JsonlAuditStore, registerSurface } from '@77systems/receipts-core';
import { createReceiptsApp, startRestServer } from '@77systems/receipts-rest';

registerSurface({ name: 'ticket-create', idPattern: /^ticket-[0-9]+$/ });
const store = new JsonlAuditStore('/absolute/path/receipts/audit.jsonl');
const running = await startRestServer({ store, port: 3101 });
// Later: await running.close();
// createReceiptsApp({ store }) exposes a Hono app for a controlled integration.
```

Registration and observation belong to trusted application code. The transport does not provide an endpoint to alter the surface registry.

```sh
npm run build
npm test --workspace @77systems/receipts-rest
```

Tests run the full uncertainty → observation → binding → verification flow through a real HTTP listener and check malformed input and local HTTP safeguards. The listener uses the [official Hono Node adapter](https://hono.dev/docs/getting-started/nodejs).
