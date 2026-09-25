# Destination verification v0.3

```text
approved payload + account + UUID action + approval
             -> SDK digest + atomic claim -> one executor call
                                                   |
                                             delivery_unknown
                                                   |
configured local connector -> real destination GET -> observed digest
                                                   |
                           append observation -> bind -> receipt
caller observation -> host-supplied audit -> bind -> cooperative receipt
```

## Evidence boundary

`record` always normalizes caller input to `host-supplied` / `independentlyVerified: false`, including objects carrying forged `provider`, `receipts-read`, or boolean flags. Direct appends to built-in stores enforce the same rule. An internal object-identity capability allows only entries created by `observeDestination(connector, request, store)` to retain read provenance. It is not a serializable capability.

`DestinationConnector` has a registered `surface` and `read(request)` returning exact `destinationAccount`, immutable `destinationId`, observed `packageDigest`, and `observedAt`. The connector performs the read itself. Core checks identity and digest validity and never guesses an object ID. A failed read issues no independent receipt. A content mismatch records placement and the observed digest without creating a binding.

Trusted connector code is installed/configured locally. MCP and REST select from startup configuration by surface; request JSON cannot install executable code, provide a provider origin, or supply a connector response. A hostile local program with arbitrary code execution or control of the audit is outside this boundary. A custom `AuditStore` is also trusted code.

`SurfaceDef.observe` is the legacy cooperative observer and permanently remains host-supplied, even when it labels evidence `provider`. It cannot become independent merely by adding fields.

## Identity and duplicate protection

An approved action has a caller UUID `actionId`, exact `destinationAccount`, and explicit `approvalId`. Payload hashes bind content; they are not action IDs. SDK claims are keyed by account/action and also refuse an approval that another action on that account has spent (see the admission lifecycle below). Reusing an attempt ID is refused. UUID case cannot bypass duplicate checks.

Claims are written before executing the callback with `writeMayHaveHappened: true`. Atomic compare-and-append prevents concurrent callers from both claiming the same audit tail. Failures to store a claim prevent dispatch. Callback success or failure cannot mint completion. Every writer must share the durable store and preserve action identity; a new empty store cannot know earlier attempts.

The provider account is part of the receipt's exact scope. Generic surface definitions validate syntax only. GitHub uses `github:owner/repo` accounts and `github:issue:owner/repo:number:immutableId` object IDs, with owner/repository names normalized to lowercase. The immutable numeric GitHub ID protects against mistaking a reused name/number for the original object. Repository renames/transfers fail closed against the configured exact account.

## Content identity

SDK `digestPayload` hashes canonical JSON, with sorted keys and rejected ambiguous non-JSON inputs. Core `digestPackage` hashes exact bytes; these encodings are not interchangeable.

GitHub's approved package is exactly `{title, body}` via `githubIssuePayload`, normalizing a null body to `''`. The account separately binds the repository. Labels, assignees, state, and comments are outside the issue package contract. A future expanded contract must define a new explicit canonicalization/version; it must not silently change old digest semantics.

## Historical and current receipts

`getReceipt(id,digest,store,scope)` returns the first historical complete binding. `verify` inspects the same local history and never performs a read. A scope can include account, action, surface, and attempt; ambiguous matches fail closed.

`observeDestination` appends a real observation and, when content matches, its binding. `recheck: true` requires a prior receipt for the action and appends a new current observation. Matching rechecks are complete; changed content is package_unverified. Both can be independently read. Neither overwrites or refreshes the original `observedAt`. An independent observation after an earlier cooperative receipt adds separate proof; the original cooperative receipt remains historical.

Consumers requiring independent proof check BOTH completion and `independentlyVerified`. SDK `claimComplete(receipt,{requireIndependent:true})` validates the supplied receipt against its exact persisted entry, including provenance, observation time, and digest. It does not silently reinterpret old proof as a fresh read.

## Storage and privacy

The synchronous `AuditStore` implements detached `read()` and atomic `append(entry,expectedLength?)`. Default `JsonlAuditStore` uses local JSONL, hash chaining, restrictive permissions, a lock, and a retained head checkpoint. Corruption, stale claims, and incomplete writes fail closed. Recovery needs operator inspection; no fallback discards history.

New records use an explicit allowlist. Payloads, provider errors, arbitrary descriptions, external references, and status strings are not retained as raw content. Description/reference digests may be stored. Account, action, attempt, approval, object, and idempotency identifiers remain visible metadata: use opaque identifiers, never secrets or payloads. Legacy logs remain readable without rewriting their original bytes or hashes; pre-existing v0.1 free text is not retroactively erased.

Connectors see destination content transiently in local memory for hashing. The GitHub token is sent only to the fixed HTTPS GitHub API origin; redirects are refused. No service receives Receipts audit logs. A hash chain is not an independent witness: rewriting the log and checkpoint defeats local tamper evidence.

## Compatibility and invariants

Pure `classify` still supports the previous data shape. New durable entries require action/account/approval identity. Legacy history can be inspected as host-supplied; completing new operations requires migration to the explicit identity fields. Unknown surfaces are rejected; locally registering executable integrations is explicit, never inferred.

The four verdicts and precedence remain `complete → delivery_unknown → package_unverified → prewrite`. Every verdict denies automatic retry and second writes. Rearm requires audited affirmative prewrite, fixed cause, new digest, and new attempt. MCP/REST remain loopback-only and are not hosted authentication services.

All connector integrations must run the public [conformance suite](../packages/conformance/README.md), plus provider-specific identity/credential-boundary tests. The real [GitHub example](../examples/github-issues/README.md) supplies the integration acceptance check.


## v0.3 admission lifecycle

The registry writes protected `claim`, `claim_expired`, `claim_released`, `claim_completed`, `duplicate`, and `policy_denied` events into the same hash chain. A dispatch is an `attempt` carrying its lease metadata and AUTHORIZED admission decision. These admission decisions are distinct from destination verdicts, so classification precedence is unchanged. Public record/direct-append routes cannot forge protected lifecycle events.

Account/action identity selects a lease; random lease ownership tokens are returned locally, while only their hashes are audited. Reclaimed unused leases advance a monotonically increasing fence. Expired or released owners cannot dispatch or complete another owner's action. The audit compare-and-append plus lock serializes both lease changes and policy budgets across processes. JSONL reads/export snapshots also hold the lock to avoid torn log/head observations.

A policy evaluated at claim time refuses a forbidden write before any reservation exists. That refusal is one registry-less `policy_denied` record: verdict `prewrite`, a named rule, no lease metadata, no execution flags, and the caller's own attempt ID. It reserves nothing, consumes no budget, spends no approval, and needs no release. Identity refusals (`DUPLICATE`) take precedence over it, because an existing possible write must be reconciled regardless of policy. Dispatch re-evaluates the same policy against the current snapshot and remains the enforcement boundary: a budget consumed between claim and dispatch is denied there, with the lease metadata attached, and the unused reservation can be released. `evaluate` is the same check as a pure pre-flight; it records nothing and its `allowed` result is not a reservation.

An approval authorizes exactly one action on its account. It is spent by any other action on that account that may have written (a dispatched attempt, `writeMayHaveHappened`, or an observed destination ID, including legacy v0.2 attempts) or that holds a live reservation, since two live reservations under one approval could both dispatch. A reservation that was released or expired unused never reached the destination and frees the approval. Refusal records never spend it. The refusal reason is `approval_reused`.

A dispatch records uncertainty atomically with policy admission. Rate limits count all such dispatches, regardless of callback outcome; policy denials consume no budget. A crash after dispatch remains uncertain forever until read-back, and TTL never permits a second write. Completion requires an exact historical binding and can be reconstructed from the audit after restart without retaining a raw lease token. Legacy v0.2 attempts do not gain invented leases and remain blocked/reconcilable under their original evidence.

Chain validation accepts a registry-less `policy_denied` only as an inert decision: verdict `prewrite`, `ruleId` present, no `writeMayHaveHappened`, and no `destinationId`. Every other admission event requires valid fenced lease metadata that matches the action's current lease. Public `record` and direct built-in-store `append` reject every admission event with `protected_admission`, including this one.

The MCP server exposes admission (claim, dispatch, release, complete, policy), digest, and signed-proof (sign, badge) tools alongside the verification tools. Their policy, claim TTL, and signing key are supplied by the local operator at startup; no tool call can change the policy, install code, or provide a key. Details are in [packages/mcp-server/README.md](../packages/mcp-server/README.md).

## Signatures, evaluations and observability

`exportAuditChain` returns a consistent local snapshot; `validateAuditChain` validates its contiguous links, signed head-compatible count/hash and evidence/admission rules without I/O. Surface definitions are trusted local configuration, never accepted from a proof. Signed proofs add Ed25519 authentication of a receipt hash, head, signer ID and signing time; verification requires the expected key separately. This establishes a local signer's attestation, not a provider signature or public authority. Full snapshot exports are opt-in and may reveal unrelated audit metadata.

Conformance benchmark 2.0.0 emits self-attested evaluation receipts. Actual case/action identities are seeded; all decisions, including unobserved ones after failure, remain represented. False-complete, false-block and unsafe-dispatch statistics retain explicit denominators. Certification eligibility requires a passing complete report and a matching publication declaration. The local checker makes no reachability or authority claim about the declared URL.

OpenTelemetry is an optional wrapper package. Unwrapped core classification remains pure. Traced operations export only allowlisted verdict/source labels and validated digests; exceptions, freeform error messages and identifiers are excluded. Instrumentation cannot alter business outcomes. The host chooses its exporter and destination; Receipts installs none.
