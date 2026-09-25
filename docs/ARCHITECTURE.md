# Destination verification

The package boundary separates a pure decision from observation and durable proof.

```text
approved payload -> SDK digest + atomic attempt claim -> one executor call
                                                        |
                                  success or uncertainty v
trusted read-only adapter -> observation audit -> bind -> verify -> completion claim
```

## Core API

`classify(write): Classification` reads no filesystem, clock, or network. `registerSurface({ name, idPattern, observe })` establishes an explicit registry entry; classification validates only its pattern and never invokes `observe`. Duplicate registration and unknown surfaces are rejected. Initialize the registry before processing requests.

`record(entry, store?)` appends validated evidence. `bind(destinationId, packageDigest, store?)` requires a previously audited provider/human observation for that exact object and digest, then appends the binding. `verify(destinationId, packageDigest, store?)` reads the audit for a valid binding. `assertComplete(classification)` rejects non-complete classifications; use `verify` or the SDK's `claimComplete` for durable proof. A standalone hypothetical classification is not itself a stored receipt.

The default `AuditStore` is synchronous local JSONL. A custom store implements `read()` and atomic `append(entry, expectedLength?)`. `read` returns detached entries; append must preserve all previous entries and enforce expected length atomically. An async hosted store requires a separate adapter/API; do not return unresolved promises from the synchronous interface.

## Observer contract

Register a custom, narrowly named surface, for example `provider-account-social`, with an anchored ID pattern and read-only `observe(write)` callback. The callback returns `{destinationId, packageDigest, evidence}`. It must:

1. Read the actual destination under the expected provider/account credentials.
2. Identify the exact object for the action; a sibling channel or different account must never satisfy the check.
3. Read back the relevant payload and compute its digest using the same canonicalization as the approved payload.
4. Return `provider` or `human` evidence with the observed ID, observed package digest, timestamp, and a useful reference. Never set the observed digest to the approved digest without comparing the destination content.
5. Never publish, send, or otherwise create a second object during observation.

Use canonical, namespaced IDs including provider and account, or custom surface-specific patterns that cannot overlap. Generic example patterns validate syntax only. Registry code and observer implementations are trusted executable code; they are not loaded from remote requests.

The SDK's `digestPayload` hashes canonical JSON with sorted keys. Include account, recipient, channel, media identity, and all other approved action details in the payload. Core `digestPackage` hashes exact bytes; these encodings are intentionally distinct. Do not interchange a raw text digest with a canonical JSON digest.

## Permission model

Only four verdicts exist. A valid bound object wins over uncertainty; uncertainty wins over unbound placement. Rearm requires explicit `neverReached: true`, `causeFixed: true`, a new SHA-256 digest, and a different attempt ID. All verdicts deny automatic retry and second writes. The SDK records uncertainty before entering the executor so a crash cannot expose a retry window.

The fallback `prewrite` classification does not assert the destination was reached or not reached when no evidence exists, and grants no permission. Integrators must set `writeMayHaveHappened` at the execution boundary; the SDK does this automatically. The hook does not provide the SDK's execution guard.

## Evidence limits

Binding checks content identity and audit consistency. It does not prove a provider signature or establish who controlled credentials. A human observation is an explicit trusted attestation. A hash chain is tamper-evident relative to a retained chain head, not a digital signature, independent witness, or protection against wholesale log replacement/truncation. No adapter may label itself production verified merely because these library checks pass.

Local MCP and REST are for trusted clients and bind to loopback. They cannot authenticate arbitrary caller-supplied evidence. A future remote deployment needs authentication, authorization, origin policy, tenant separation, and protected audit storage outside this v1 scope.
