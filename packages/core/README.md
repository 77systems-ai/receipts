# @77systems/receipts-core

Verification for every AI agent. A dependency-free TypeScript mechanism for Node.js 20+ that classifies destination evidence and records append-only receipts.

```sh
npm install @77systems/receipts-core
```

## The classification is pure

```ts
import { classify, digestPackage } from "@77systems/receipts-core";

const packageDigest = digestPackage("The exact approved message");
const write = {
  surface: "social-publish",
  attemptId: "post-attempt-1",
  packageDigest,
  writeMayHaveHappened: true,
};

console.log(classify(write));
// verdict: "delivery_unknown"
// mayAutoRetry: false, maySecondWrite: false, mayRearm: false
```

`classify` never calls a provider, reads storage, observes the clock, or writes anything. Its normalized inputs are a trust boundary: the caller is responsible for truthful evidence. `boundPackageDigest` describes a binding already established by a trusted caller. A pure classification is not a durable receipt; use `bind` and `verify` for audited completion.

The verdict precedence is `complete` → `delivery_unknown` → `package_unverified` → `prewrite`. All classifications forbid automatic retries and second writes. Rearming is available only for a prewrite with `neverReached: true`, `rearm.causeFixed: true`, a different `rearm.previousDigest`, and a different `rearm.previousAttemptId`. Recording that rearm also requires its previous prewrite to exist in the audit. Missing evidence falls into `prewrite` with rearming disabled; status flags never establish success or uncertainty.

## Observe an existing object, then bind it

Destination observation happens outside core. The adapter must independently read the object and hash the exact relevant content, or accept an explicit human attestation. An executor's successful response is not read-back proof.

```ts
import {
  assertComplete, bind, createAuditEntry, JsonlAuditStore, record, verify,
} from "@77systems/receipts-core";

const store = new JsonlAuditStore("./receipts.jsonl");
record(createAuditEntry(write, "attempt"), store);

// After your provider adapter actually reads the existing object:
const destinationId = "post-123";
const observedDigest = packageDigest; // Compute from read-back content in production.
record(createAuditEntry({
  surface: write.surface,
  attemptId: write.attemptId,
  packageDigest,
  destinationId,
  publicObjectExists: true,
  evidence: [{
    source: "provider",
    detail: "Read back the published message and compared its exact approved content.",
    destinationId,
    packageDigest: observedDigest,
  }],
}, "observation"), store);

bind(destinationId, packageDigest, store);
console.log(verify(destinationId, packageDigest, store)); // "complete"
assertComplete(destinationId, packageDigest, store);
```

`bind` requires an earlier observation with `source: "provider"` or `"human"`, the exact destination ID, and the same SHA-256 digest. It appends a binding entry referencing that observation. A mismatching payload, invented ID, executor status, or absent observation is refused. Repeating the same binding is idempotent. An existing object and digest cannot be credited to a second attempt; reconciliation must retain the original attempt ID. IDs that match multiple surfaces or attempts are refused as ambiguous; use canonical surface-qualified IDs in adapters.

`verify` reads the audit and returns one of the four verdicts. `record` rejects contradictory verdicts, reused entry IDs, attempt IDs that switch payload or surface, and completion without an earlier audited binding. It returns `void` after the append finishes. `assertComplete(classificationOrVerdict)` is also available for trusted values; its ID/digest/store overload checks the audit.

## Register a surface

The built-in examples are `http-post`, `social-publish`, `email-send`, and `file-write`. Unknown names throw `ReceiptsError` with `code: "not_a_destination_write"`; this is an error, not a fifth verdict.

```ts
import { registerSurface } from "@77systems/receipts-core";

registerSurface({
  name: "my-message-service",
  idPattern: /^my-message-service:message:\d+$/,
  async observe(write) {
    // Your trusted adapter performs a read here. Core never invokes this callback.
    const observed = await readActualMessage(write.attemptId);
    return {
      destinationId: observed.canonicalId,
      packageDigest: observed.contentDigest,
      evidence: [{
        source: "provider",
        detail: "Read the message from the destination service.",
        destinationId: observed.canonicalId,
        packageDigest: observed.contentDigest,
      }],
    };
  },
});
```

The callback example needs your own `readActualMessage` implementation. Pattern validation is syntactic; it cannot prove ownership or provenance. Duplicate registration is refused. Register custom surfaces in every process before reading their entries.

## Audit storage

The default store uses `RECEIPTS_AUDIT_PATH`, or `.receipts/audit.jsonl`. Every line includes a sequence number, the previous line's hash, the entry, and a SHA-256 hash of canonical JSON. Entries carry timestamp, surface, verdict, destination ID when known, package digest, attempt ID, and supporting evidence.

The `.head` checkpoint detects missing log files and suffix truncation while the checkpoint is retained. An exclusive `.lock` prevents concurrent appends. A lock, changed expected length, malformed entry, incomplete write, hash mismatch, or checkpoint mismatch fails closed. No lock is automatically stolen. A crash can leave a lock or a log/checkpoint mismatch; preserve the files and inspect them before recovery. There is no automatic repair that deletes evidence.

The chain is tamper-evident local storage, not a signature or an external trust anchor. Someone able to rewrite both the log and its checkpoint can reconstruct them. Back up both files together; stronger retention and independent anchoring belong in a hosted backend.

Custom stores implement synchronous `read(): readonly AuditEntry[]` and `append(entry, expectedLength?): void`. Reads must return detached copies; append must validate and preserve existing entries, and atomically compare the expected length when supplied. `record(entry, store, expectedLength)` supports compare-and-append claims. Asynchronous backends are outside this API and are refused. `MemoryAuditStore` provides the same append-only contract for tests and embedded use.

The library checks consistency and integrity, not the truthfulness of a provider/human label. Keep record and binding authority inside a trusted adapter or operator boundary. Do not expose these methods as public unauthenticated proof-creation endpoints.
