# Destination verification v0.2

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

An approved action has a caller UUID `actionId`, exact `destinationAccount`, and explicit `approvalId`. Payload hashes bind content; they are not action IDs. SDK claims are keyed by account/action and also reject recycled approvals for that account. Reusing an attempt ID is refused. UUID case cannot bypass duplicate checks.

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
