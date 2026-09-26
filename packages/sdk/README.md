# Receipts SDK

Wrap the actual outward-write call, persist its approved action before dispatch, and refuse duplicate execution after an uncertain outcome. Payloads are hashed in memory using deterministic JSON serialization; the local audit stores digests and identifiers, never payload content or provider error messages.

```ts
import { randomUUID } from "node:crypto";
import { createReceipts } from "@77systems/receipts-sdk";

const receipts = createReceipts({ connector }); // Trusted local connector code.
const receipt = await receipts.execute({
  surface: connector.surface,
  attemptId: "attempt-001",
  actionId: randomUUID(), // Save and reuse this UUID for this approved action.
  destinationAccount: "github:77systems-ai/receipts-test",
  approvalId: "approval-001", // Identifier from your own approval flow.
  payload: approvedPayload,
  execute: ({ payload, idempotencyKey }) => destination.write(payload, { idempotencyKey }),
});
```

`connector`, `destination`, and `approvedPayload` above are local application objects. The SDK does not issue approvals. See the runnable [GitHub example](../../examples/github-issues) for an independently verified integration and the [Grok example](../../examples/grok-bot) for an offline cooperative demonstration.

## Action identity and uncertain writes

Every execution requires an exact `destinationAccount`, a caller-generated UUID `actionId`, an explicit `approvalId`, and a unique `attemptId`. The same account and action cannot execute twice, even if a caller changes the attempt, provider idempotency key, or content. Reusing an approval for a new action on that account is refused while the earlier action may have written or holds a live reservation; a released or expired unused reservation frees it. A new action with a new approval may intentionally contain identical content; digest equality alone never blocks it. Persist and share these identifiers across every process handling an action.

The SDK atomically appends an uncertain claim before dispatch. A thrown callback becomes `delivery_unknown`; its raw error is never written to the audit. A normal callback return is not evidence either. An object ID in the write response cannot mint a receipt. The SDK never automatically retries a write.

```ts
const verified = await receipts.reconcile({
  surface: connector.surface,
  attemptId: "attempt-001",
  payload: approvedPayload,
  locator: { issueNumber: 42 }, // Known provider coordinates; never audited.
});
receipts.claimComplete(verified, { requireIndependent: true });
```

Reconciliation reads the original action identity from its execution claim, verifies the approved payload digest, and invokes only the read-only connector. Supply a canonical `destinationId` or connector-specific `locator`. A connector can be configured on `createReceipts` or supplied per `reconcile`/`recheck`. Connector code is trusted local executable configuration, never code supplied through remote tool arguments. Read failures remain uncertain; persistence failures throw.

## Proof source and history

Every execution receipt includes the account, object ID (or `null` while unknown), action ID, approval ID, package digest, `evidenceSource`, `independentlyVerified`, and `observedAt`. The time is `null` until a destination observation occurs.

- Core-executed connector reads have `evidenceSource: "receipts-read"` and `independentlyVerified: true`.
- A registered `SurfaceDef.observe` callback is the permanent cooperative path. Even if it labels its evidence `provider`, its receipts have `evidenceSource: "host-supplied"` and `independentlyVerified: false`.

`claimComplete(receipt)` checks durable scoped proof. Add `{ requireIndependent: true }` when your application requires a connector read. A caller cannot change the returned source flags to promote cooperative evidence.

`recheck({ surface, attemptId, payload, destinationId, connector? })` appends another observation. Its timestamp describes that new read. The original receipt remains valid historical evidence at its original time; a later content edit yields a separate `package_unverified` recheck. Do not describe a historical receipt as a live check.

## Cooperative observers

Registered cooperative observers return `{ destinationId, packageDigest, evidence }`. They must read the intended account and exact object, calculate the digest from the observed content using `digestPayload`, and provide provider/human evidence for the same ID and digest. Host assertions remain explicitly host-supplied regardless of claimed provenance. This preserves chat integrations without pretending Receipts independently authenticated their reads.

## Execution and persistence boundary

All callers must share one durable `AuditStore`. Custom stores must implement synchronous reads and atomic `append(entry, expectedLength)` without overwriting entries. A failed required append cannot return completion. The default store is local, append-only, and hash chained.

Approved payloads are detached and recursively frozen before dispatch. Only plain JSON values are supported; cycles, undefined values, non-finite numbers, sparse arrays, getters, class instances, and symbol keys are rejected. Object keys sort; array order matters. The encoding is `receipts-json-v1`, not RFC 8785.

The wrapper governs its own executor path. Application code that calls a provider directly bypasses it; the SDK is not a sandbox for arbitrary code or a language model's final wording.


## v0.3 admission and policy

`createReceipts({ store?, connector?, policy?, claimTtlMs? })` uses core's atomic idempotency registry. `execute` reserves the approved action, dispatches it under policy, and only then invokes the callback. The dispatch append both consumes the rate budget and records uncertainty before the callback. A default client behaves as before, with additional audit events.

`policy` supports `{defaultEffect?:'allow'|'block',rules:[{id,effect,surface?,destinationAccount?}],rateLimits:[{id,maxWrites,windowMs,surface?,destinationAccount?}]}`. Omitted configuration is permissive within registered surfaces. Explicit blocks win. Rates count dispatched attempts in the sliding window, including uncertain writes, across clients sharing the store. Host code owns policy configuration; do not accept arbitrary policy overrides from an untrusted agent. The client copies the policy at construction; a structurally invalid policy throws core's `invalid_policy` from `execute` before anything is recorded.

Policy is evaluated twice on purpose:

1. **At claim (fail fast).** A forbidden write is refused before any reservation exists. The audit gains exactly one `policy_denied` record with no lease metadata and verdict `prewrite`. The callback is never invoked, no budget is consumed, the approval is not spent, and there is no reservation to release. `execute` throws `PolicyDeniedError`.
2. **At dispatch (enforcement).** The same policy is re-evaluated against the current durable snapshot. A shared budget consumed between the two steps by another client or process is denied here: the audit shows `claim`, `policy_denied` carrying the lease metadata, and `claim_released`; the unused reservation is released and `execute` throws `PolicyDeniedError`. If the release fails because the reservation expired or a new owner reclaimed it (`claim_expired`, `stale_claim`), the named denial is still thrown; any other release failure propagates.

Neither denial spends the approval, so a deliberate policy correction can authorize the same never-dispatched action with its original approval.

`DuplicateWriteError` has `code: 'duplicate_write_refused'`, `verdict: 'DUPLICATE'`, and `decision`, the persisted admission decision with its `auditEntryId` and `reason` (`active_claim`, `completed`, `dispatched`, or `approval_reused`); the property is optional in the type and always supplied by `execute`. `PolicyDeniedError` has `code: 'policy_denied'`, `verdict: 'policy_denied'`, `ruleId`, and `decision` with the `auditEntryId` of the denial from whichever step refused. Both are thrown before the callback runs; no destination write was made. Unknown surfaces and audit failures still fail closed.

Every refusal says what to do next. `DuplicateWriteError`, `PolicyDeniedError`, and `VerificationPendingError` carry a `hint` from the [error taxonomy](../../docs/ERRORS.md); the duplicate's message names its reason and appends that hint. For a reused approval it reads "Request a separate approval per write: each approval ID authorizes exactly one action." Core `ReceiptsError` values expose the same guidance as `error.hint` and `error.docs`.

```ts
import { createReceipts, DuplicateWriteError, PolicyDeniedError } from "@77systems/receipts-sdk";

try {
  await receipts.execute(options);
} catch (error) {
  if (error instanceof PolicyDeniedError) console.log(error.ruleId, error.decision.auditEntryId);
  else if (error instanceof DuplicateWriteError) console.log(error.decision?.reason); // Reconcile; do not execute again.
  else throw error;
}
```

`client.registry` exposes local claim management for integrations that need it. Reservations default to 60 seconds. Expiry only recovers unused reservations; a dispatched write never becomes retryable because time passed. An approval is spent by any other action on the same account that may have written or holds a live reservation; released or expired unused reservations free it, and refusal records never spend it. Successful read-back marks a leased action completed through core's `completeVerified`, including reconciliation by a newly created client after restart. Legacy v0.2 attempts without leases retain their original safe reconciliation path.
