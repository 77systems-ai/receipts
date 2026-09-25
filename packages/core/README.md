# @77systems/receipts-core

Destination verification for Node.js 20+, with zero runtime dependencies.

`classify(write)` is pure: no network, filesystem, clock, or mutation. Verdict precedence remains `complete → delivery_unknown → package_unverified → prewrite`. Unknown surfaces throw `not_a_destination_write`. All verdicts refuse automatic retries and second writes. A status flag never proves completion. A pure classification is a decision over supplied input, not a durable receipt.

## Identity and cooperative evidence

New audit entries require a caller-generated UUID `actionId`, exact `destinationAccount`, `approvalId`, `attemptId`, surface, and SHA-256 package digest. A new intentional action needs a new action ID and approval; an uncertain repeat of the same account/action cannot claim another attempt. Use the SDK to persist the claim before making a write.

```ts
import { randomUUID } from "node:crypto";
import {
  bind, createAuditEntry, digestPackage, getReceipt, MemoryAuditStore, record,
} from "@77systems/receipts-core";

const store = new MemoryAuditStore();
const action = {
  surface: "social-publish",
  attemptId: randomUUID(),
  actionId: randomUUID(),
  destinationAccount: "social:account-42",
  approvalId: "approval-42",
  packageDigest: digestPackage("Exact approved content"),
};

// An observation supplied by a host application or human stays cooperative.
// Both the ID and digest must come from the host's actual destination read.
record(createAuditEntry({
  ...action,
  destinationId: hostObservation.id,
  evidence: [{
    source: "provider",
    detail: "Host-provided destination observation",
    destinationId: hostObservation.id,
    packageDigest: hostObservation.digest,
    observedAt: hostObservation.observedAt,
  }],
}, "observation"), store);

const receipt = bind(hostObservation.id, action.packageDigest, store, action);
// receipt.evidenceSource === "host-supplied"
// receipt.independentlyVerified === false
```

`hostObservation` represents a real read performed by your host. Caller-supplied `provider` labels and trust flags never earn independent verification. Both `record` and the built-in stores' direct `append` normalize caller observations to `host-supplied`. Cooperative receipts can still be `complete`; consumers requiring independent proof must also require `independentlyVerified === true`.

## Connector reads

A `DestinationConnector` (also exported as `TrustedConnector`) is trusted local executable configuration:

```ts
interface DestinationConnector {
  surface: string;
  read(request: ConnectorRequest): ConnectorObservation | Promise<ConnectorObservation>;
}
// ConnectorObservation: { destinationAccount, destinationId, packageDigest, observedAt }
```

`observeDestination(connector, request, store?)` invokes `read` itself, validates the exact account, object when supplied, digest, and observation time, appends a trusted observation, and binds matching content. It returns a `Receipt`. The connector must read the actual destination content and compute its digest using the same serialization as the approval; returning the requested digest without comparing content violates the connector contract.

`ConnectorRequest` contains action identity and approved digest, optional expected `destinationId`, optional transient `locator`, and optional `recheck`. Locators and provider response content are not stored. Read failures throw `connector_read_failed`; account and object mismatches throw `account_mismatch` and `object_mismatch`. Audit failures propagate. No failure authorizes another write.

Only this core-executed path creates `receipts-read` provenance. The internal capability is an in-memory object identity, not a JSON property. A serialized forged flag cannot use it. The trusted boundary includes installed connector code, custom store code, local credentials, and filesystem access. A caller able to replace executable code or rewrite the audit and head checkpoint is outside that boundary; this is not provider-signed or remotely attested proof.

## Receipts and rechecks

Every new receipt contains the exact account, object ID, action ID, approval ID, approved package digest, evidence source, independent-verification flag, observation time, and references to the audit and observation entries.

- `bind(id, digest, store?, scope?)` binds an earlier matching observation and inherits its provenance. Repeated public binding is idempotent.
- `getReceipt(id, digest, store?, scope?)` returns the first immutable bound receipt or `undefined`.
- `verify(id, digest, store?, scope?)` checks historical audit state and returns a verdict; it does not contact a provider.
- `observeDestination(connector, {...request, recheck: true}, store)` requires an existing receipt and appends a current observation. Matching content produces a new complete result with its new observation time. Changed content produces `package_unverified` with `observedPackageDigest`. The original receipt and its original `observedAt` remain unchanged.

Scope supports `destinationAccount`, `actionId`, `surface`, and `attemptId`. Ambiguous unscoped IDs are rejected. Every read creates its own proof: a later independent read can add independent proof after a cooperative receipt, while the first historical receipt remains available. Hold the returned new receipt when its specific observation is needed.

## Registry and storage

The existing generic surfaces are `http-post`, `social-publish`, `email-send`, and `file-write`; the GitHub connector registers `github-issue`. Registration is explicit through `registerSurface({name, idPattern})`. Pattern validation checks shape, not authenticity. The legacy `SurfaceDef.observe` callback remains cooperative when invoked by a host or SDK; independent verification requires `observeDestination`.

The default `JsonlAuditStore` uses `RECEIPTS_AUDIT_PATH` or `.receipts/audit.jsonl`. Entries commit to their predecessor hash; the `.head` checkpoint detects tail loss while retained. Exclusive locking and atomic expected-length comparison refuse competing writes. Corruption and incomplete writes fail closed; preserve both files for inspection. No automatic cleanup removes audit evidence.

New writes use a strict field allowlist. Payloads, credentials, provider response bodies, arbitrary extra properties, and status text are not retained. Freeform evidence descriptions and external references become SHA-256 digests; displayed descriptions are code-defined summaries. Identifier fields are metadata: use opaque IDs, never credentials or payload text. The audit remains on the local machine. Existing v0.1 chains are readable without rewriting their hashes and are treated as cooperative; missing legacy scope is reported as `legacy-unknown`.

`MemoryAuditStore` implements the same synchronous append-only rules. Custom stores implement synchronous `read(): readonly AuditEntry[]` and `append(entry, expectedLength?): void`, return detached entries, preserve order, and compare the expected length atomically. Custom store implementations are trusted application code. Async stores are outside this API.
