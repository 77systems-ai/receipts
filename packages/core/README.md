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

## Atomic admission and policy (v0.3)

Admission is separate from the four destination-verification verdicts. Admission verdicts (`CLAIMED`, `AUTHORIZED`, `DUPLICATE`, `policy_denied`, `RELEASED`, `COMPLETED`, `EXPIRED`) are recorded in `entry.admission` and never merge into classification. Every decision, lease change, and dispatch is appended to the same append-only hash chain.

```ts
import { createIdempotencyRegistry } from "@77systems/receipts-core";

const policy = {
  rules: [{ id: "block-archived-account", effect: "block", destinationAccount: "social:archived" }],
  rateLimits: [{ id: "hourly-social-budget", surface: "social-publish", maxWrites: 10, windowMs: 3_600_000 }],
};
const registry = createIdempotencyRegistry({ store, ttlMs: 60_000 });
const result = registry.claim(action, policy);
if (result.verdict === "DUPLICATE") {
  // Reconcile the existing action; result.reason says why. Do not invoke the outward writer.
} else if (result.verdict === "policy_denied") {
  // One audited decision naming result.ruleId. Nothing was reserved, so there is nothing to release.
} else {
  const admission = registry.dispatch(result.claim, policy);
  if (admission.verdict === "policy_denied") {
    registry.release(result.claim); // Still unused; no write was authorized.
  } else {
    // Only now invoke the outward writer once. A failure is delivery_unknown.
    // After an exact destination read and binding:
    // registry.complete(result.claim, actualDestinationId);
  }
}
```

**Approval reuse.** An approval authorizes exactly one action on its account. It is spent by any other action on the same account that may have written (an audited `attempt`, `writeMayHaveHappened`, or an observed `destinationId`, including legacy v0.2 attempts) or that holds a live reservation (an unexpired, unreleased `claim`): two live reservations under one approval could both dispatch. A reservation that was released or that expired unused never reached the destination and frees the approval. Refusal records (`duplicate`, claim-time `policy_denied`) never spend it. A claim refused for this reason returns `DUPLICATE` with `reason: "approval_reused"`; a new intentional action needs a new approval.

### Registry construction

`createIdempotencyRegistry({ store?, ttlMs?, now? })` (or `new IdempotencyRegistry(options)`). `store` defaults to `getDefaultStore()`. `ttlMs` defaults to 60 000 and must be a safe integer from 1 millisecond to 30 days, otherwise `invalid_claim_ttl`. `now` overrides the clock for deterministic tests; it must be a function returning a safe nonnegative millisecond timestamp, otherwise `invalid_clock`. Only unused reservations expire; dispatch permanently disables TTL recovery.

Every method reads a validated snapshot, decides, and appends with the snapshot length as the expected length. `audit_locked` and `audit_conflict` are retried up to 100 times with bounded synchronous backoff (at most 20 ms per retry, which also coordinates separate Node processes through the JSONL lock); sustained contention fails closed with `audit_busy` and authorizes nothing. Invalid identity (`action_identity_required`, `invalid_action_id`, `invalid_write`, `invalid_digest`, `not_a_destination_write`) throws before any record. Identity data is allowlisted before it is audited: payload or credential properties on an action object are dropped, never stored.

### claim

`claim(action)` returns `ClaimDecision`, deciding on identity alone. `claim(action, policy)` returns `ClaimDecision | PolicyDeniedDecision` and additionally evaluates the host's policy. Call it once per approved action before anything else, and hold the returned lease privately.

Identity refusals take precedence over policy and are checked in this order: `completed` (an audited `claim_completed` or `binding` for the action), `dispatched` (any possible write for the action), `approval_reused` (above), and `active_claim` (an unexpired, unreleased reservation already exists). Each appends a `duplicate` event with `{ verdict: "DUPLICATE", reason }` and returns `{ verdict: "DUPLICATE", reason, auditEntryId }`. An expired unused reservation for the action is first recorded as `claim_expired` (`EXPIRED`); the claim is then re-evaluated against the updated tail, where a competitor may win.

A policy denial at claim is one audited registry-less record: event `policy_denied`, `admission: { verdict: "policy_denied", ruleId }`, verdict `prewrite`, no `registry` lease metadata, and the caller's own `attemptId`. It reserves nothing, consumes no budget, spends no approval, and needs no release; a later `claim` of the same action under a corrected policy proceeds. The return value is `{ verdict: "policy_denied", ruleId, auditEntryId }`. This check is early feedback: `dispatch` re-evaluates the same policy and remains the enforcement boundary.

Otherwise the registry appends a `claim` event (`CLAIMED`) and returns `{ verdict: "CLAIMED", claim, auditEntryId }`. `claim` is a frozen `ClaimLease`: the action identity plus `leaseId`, a random 32-byte hex `token`, a `fence`, and `expiresAt`. Claims key on the exact destination account plus the UUID action ID; only the UUID compares case-insensitively, every other identity field is exact. Only the token's SHA-256 digest (`tokenHash`) is audited, so exporting an audit does not export active lease authority. Each reclaim of an unused action advances the fence by one.

### evaluate, validatePolicy, and evaluatePolicy

`registry.evaluate(action, policy = {})` is a read-only pre-check against the current durable snapshot. It returns `PolicyEvaluation`: `{ verdict: "allowed" }` or `{ verdict: "policy_denied", ruleId }`. It records nothing and consumes no budget, and `allowed` is not a reservation; only `claim` and `dispatch` change durable state. Use it for feedback before an approval is requested, never as authorization. It throws `invalid_policy`, `not_a_destination_write`, the identity errors above, and `audit_busy`.

```ts
const preview = registry.evaluate(action, policy);
if (preview.verdict === "policy_denied") console.log(`Rule ${preview.ruleId} would deny this write.`);
```

`validatePolicy(policy)` validates the host-owned configuration structurally and evaluates nothing. It throws `invalid_policy` when `defaultEffect` is not `allow` or `block`, `rules` or `rateLimits` are not arrays, a rule `id` is missing, duplicated across both lists, or does not match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, a `destinationAccount` is not an exact trimmed identifier, an `effect` is not `allow` or `block`, or a rate limit lacks a nonnegative safe-integer `maxWrites` and a positive safe-integer `windowMs`. A rule `surface` must be registered (`not_a_destination_write`). `claim` with a policy, `evaluate`, and `dispatch` all call it. `evaluatePolicy(action, policy, entries, now)` is the pure function underneath, evaluating against a supplied snapshot without a registry.

### dispatch

`dispatch(lease, policy = {})` requires the held, unused, unexpired lease and re-evaluates policy against the current snapshot. A denial appends a `policy_denied` event carrying the lease metadata and returns `{ verdict: "policy_denied", ruleId, auditEntryId }`; no budget is consumed, and the lease stays unused: release it, dispatch it again once the budget frees, or let it expire. Otherwise it atomically appends the execution `attempt` with `admission: { verdict: "AUTHORIZED" }`, `writeMayHaveHappened: true`, `neverReached: false`, and classification `delivery_unknown`; that append is what consumes the shared rate budget. It returns `{ verdict: "AUTHORIZED", auditEntryId }`. Persisting that attempt happens before the provider callback. Once dispatched, a crash, expired TTL, read failure, or release request cannot authorize another write. Observe and bind the existing destination instead.

Lease checks apply to `dispatch`, `release`, and `complete`. `stale_claim`: the lease's identity, `leaseId`, `fence`, `expiresAt`, or token (compared in constant time against the audited digest) does not match the action's current lease record, including after a new owner reclaimed the action. `claim_dispatched`: the current record is no longer an unused `claim` (dispatched, released, or completed). `claim_expired`: the unused lease expired before dispatch or release; the registry records `claim_expired` and the owner must obtain a new fenced claim. A stale owner can never dispatch, release, or complete a newer claim.

### release

`release(lease)` gives up an unused live reservation, appends `claim_released` (`RELEASED`), and returns `{ verdict: "RELEASED", auditEntryId }`. It frees the approval and lets a new fenced owner claim the action. It throws the lease errors above; a dispatched reservation cannot be released (`claim_dispatched`) because its outcome must be reconciled.

### complete and completeVerified

`complete(lease, destinationId)` requires the held lease (`stale_claim`), a durable dispatch (`claim_not_dispatched`), and an existing audited `binding` with verdict `complete` for the exact action identity and that object (`observation_required`); it never invents a destination ID. It appends `claim_completed` (`COMPLETED`) carrying `destinationId`, `boundPackageDigest`, and verdict `complete`, and returns `{ verdict: "COMPLETED", auditEntryId }`. Repeating completion is idempotent and returns the original decision; a different object throws `object_mismatch`.

`completeVerified(action, destinationId)` applies the same rules without the raw lease token: after a restart, the audited dispatch and binding supply the authority. It throws `stale_claim` when no lease record matches the exact action identity. The SDK calls it after a complete read-back. Existing v0.2 attempts retain their original safety rules and can still reconcile through ordinary read-back/binding; they lack lease metadata and do not need a registry-completion event.

### Policy semantics

The default policy permits registered surfaces. Explicit matching block rules always win. Allow rules do not silently turn the policy into a whitelist; set `defaultEffect: "block"` when that behavior is intended. An unmatched explicit default block names `default-policy`. Rate rules count durable attempts across the configured surface/account scope during a rolling window, including uncertain dispatches and existing v0.2 attempts. A clock rollback counts future-dated attempts conservatively. Policy denials at either step consume no budget.

### Audit protection

`DUPLICATE` refusal records use a fresh decision-only attempt UUID, so a caller's changed package or idempotency key cannot amend the original execution attempt. They are admission refusals, never execution attempts. Public `record` and direct built-in-store `append` reject every admission event, lease field, and admission field with `protected_admission`, including a registry-less `policy_denied`. Chain validation accepts a registry-less `policy_denied` only as an inert record: verdict `prewrite`, a named rule, no `writeMayHaveHappened`, and no `destinationId`. Separate registry instances and Node processes coordinate through the store's atomic expected-length check and JSONL lock; JSONL reads and exports hold the same lock for a consistent log/checkpoint snapshot. A crash during a store operation can still require inspection of a stale lock or interrupted append; lease TTL is not permission to rewrite an inconsistent audit.

## Offline audit export

`exportAuditChain(store?)` returns `{envelopes, head}`. JSONL exports retain the original envelope hashes; memory and trusted custom stores produce the same canonical envelope format from their validated entries. `validateAuditChain(bundle)` checks every hash, link, entry, and head checkpoint offline and throws `audit_corrupt` on failure. Register the relevant surface definitions before validating, including the GitHub issues connector when the chain uses that surface.

Export is opt-in and does not contact Receipts or a provider. It contains scoped audit metadata, such as account and action identifiers. Legacy v0.1 records retain their original freeform evidence to preserve old hashes; inspect a legacy-containing export before publishing it. A chain proves integrity relative to its retained head; signer identity and trust are separate concerns handled by the signed-receipt package.
