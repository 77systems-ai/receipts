# Receipts error taxonomy

Generated from `packages/core/src/errors.ts` by `npm run docs:errors`; do not edit by hand. Every code Receipts returns, throws, audits, or prints maps to one entry here, and a core test refuses source code that introduces a code without one. Programmatic access: `describeError(code)` from `@77systems/receipts-core`, or `error.hint` and `error.docs` on any `ReceiptsError`.

Every entry says what to do next. Two rules hold throughout: no fix ever repeats an uncertain outward write, and no message ever contains payload content, credentials, or raw provider errors. The first section covers the non-complete destination verdicts, which are answers rather than errors; MCP observe and recheck results carry their guidance as `hint`. SDK argument and payload validation raise `TypeError` values that carry a `code` property from this table (`invalid_write`, `invalid_payload`).

## Destination verdicts that are not complete (answers, not errors)

### delivery_unknown

**Probable cause.** A write may have reached the destination, but no read-back has bound it to the approved package: the executor threw, the response was lost, or the read-back could not find or read the object.

**What to do.** Do not write again. Read the destination back with the original attemptId and a real locator (receipts.observe or the SDK's reconcile); if the object is not there yet, read again later. The action stays uncertain until an observation settles it.

### package_unverified

**Probable cause.** The destination object exists, but the bytes written differ from the claimed bytes (observedPackageDigest shows what was found), or an object exists with no binding to the approved package.

**What to do.** The bytes written differ from the claimed bytes: claim from the staged file instead of re-authoring the content (receipts.prepare with file, then copy that file unchanged). Do not write this action again; inspect the object, and correct it only as a new action with its own approval.

### prewrite

**Probable cause.** No destination evidence exists yet, or the destination was affirmatively never reached.

**What to do.** Nothing is known to have been written. Proceed only through claim and dispatch; rearm a failed attempt only after fixing the cause, with a new digest and a new attempt.

## Input validation (core classify, record, bind, verify)

### invalid_write

**Probable cause.** An outward write or SDK execute option is missing, or an identity field (attemptId, destinationAccount, approvalId, idempotencyKey, statusFlag) is empty, unbounded, has surrounding whitespace or control characters, or a flag is not a boolean.

**What to do.** Supply a nonempty attemptId, opaque identifiers of at most 256 characters without surrounding whitespace, and boolean flags. Never place payload text or secrets in identifier fields.

### invalid_digest

**Probable cause.** A packageDigest, boundPackageDigest, observed digest, or evidence digest is not a lowercase `sha256:` hex digest of 64 characters.

**What to do.** Hash the exact approved payload with the SDK's digestPayload (canonical JSON) or core's digestPackage (exact bytes). Do not substitute a provider token or an observed digest for the approved one.

### invalid_payload

**Probable cause.** digestPackage received something other than a string or bytes, or the SDK / receipts.digest received a value that is not plain JSON (undefined, NaN, Infinity, BigInt, cycles, sparse arrays, getters, class instances, symbol keys).

**What to do.** Serialize structured payloads first, or pass plain JSON values only. The SDK rejects ambiguous inputs instead of silently coercing them.

### invalid_action_id

**Probable cause.** actionId is not a UUID.

**What to do.** Generate one UUID per approved logical action, persist it, and reuse it on uncertain retries. A separately approved action needs a new UUID.

### invalid_destination_id

**Probable cause.** destinationId is empty, has surrounding whitespace, or does not match the registered surface's ID pattern.

**What to do.** Pass the exact identifier observed at the destination in the surface's canonical form. Never invent or normalize an ID to make it fit.

### invalid_evidence

**Probable cause.** An evidence item lacks a recognized source (provider, human, executor, binding) or a nonempty detail, or has a malformed observedAt, destinationId, reference, or digest.

**What to do.** Provide evidence with a recognized source, a nonempty summary, and valid timestamps and digests. Freeform detail is hashed, never stored.

### invalid_rearm

**Probable cause.** A rearm object is malformed, or rearming was attempted without an audited prewrite attempt carrying the previous digest and affirmative never-reached evidence.

**What to do.** Record the failed prewrite attempt with neverReached true first. Rearm only after a fixed cause, with a new digest and a new attempt ID.

### invalid_surface

**Probable cause.** registerSurface received a name that is not lowercase-hyphenated, an idPattern that is not a RegExp, or a non-function observer.

**What to do.** Register surfaces from trusted startup code with a lowercase hyphenated name and a RegExp ID pattern.

### surface_already_registered

**Probable cause.** registerSurface was called twice for the same surface name in one process.

**What to do.** Register each surface once at startup. Guard optional registrations with getSurface and catch not_a_destination_write, as the GitHub connector does.

### not_a_destination_write

**Probable cause.** The surface named in a write, action, policy rule, or connector request is not registered in this process. Unknown surfaces are rejected, never guessed; this is an error code, not a fifth verdict.

**What to do.** Register the surface locally before classifying or claiming, or import the connector package that registers it (for GitHub, @77systems/receipts-github).

### invalid_entry

**Probable cause.** An audit entry violates a structural or lifecycle rule: its verdict contradicts its evidence, its ID is not a UUID, an attempt changed surface, digest, identity, or idempotency key, an observation lacks provider or human evidence for the exact object, a binding's provenance does not match its observation, or lease metadata is inconsistent.

**What to do.** Build entries with createAuditEntry and let core derive verdicts. Reuse the original action identity across an attempt. Do not hand-edit entries or lease metadata.

### duplicate_entry

**Probable cause.** An entry with the same ID is already recorded.

**What to do.** Create a fresh entry with a new UUID. Do not re-append a stored entry.

### duplicate_attempt

**Probable cause.** An execution attempt was recorded, or a reservation was dispatched or released, for an account and action that already has a possible or observed write (including a write made without dispatch and then observed).

**What to do.** Reconcile the existing write by reading the destination back and binding it. Never start a second write for the same approved action; a reservation that outlives its write is spent, not reusable.

### ambiguous_destination

**Probable cause.** The object and digest match more than one account, action, surface, or attempt, or a new observation of this object and digest belongs to another attempt.

**What to do.** Supply destinationAccount and actionId (and surface or attemptId when needed) as scope, or reconcile the original attempt instead of creating a new one.

### observation_required

**Probable cause.** bind, recheck, completion, or a complete classification was requested without an audited observation or binding of this exact object and approved digest for the same action.

**What to do.** Observe the destination first (a locally configured connector read, or a host observation recorded through record), then bind it. Completion is never granted without that binding.

### not_complete

**Probable cause.** assertComplete was called for a verdict other than complete.

**What to do.** Do not claim completion. Read the destination back, bind the exact object, and re-verify.

### action_identity_required

**Probable cause.** A new durable audit entry, observation, or claim lacks actionId, destinationAccount, or approvalId.

**What to do.** Add the caller UUID actionId, the exact destinationAccount, and the host approvalId. Legacy v0.1 entries stay readable but cannot complete new operations.

## Audit store integrity and concurrency

### audit_corrupt

**Probable cause.** The JSONL log, its hash chain, or its head checkpoint failed integrity validation: a broken link, an incomplete final line, a missing log with a retained head, or an exported chain that does not validate.

**What to do.** Stop writing. Preserve the log, its .head checkpoint, and any .lock for inspection. Never delete, truncate, or rewrite them to recover; restore from a trusted copy instead. No verdict can be trusted from a corrupt chain.

### audit_locked

**Probable cause.** Another process holds the audit lock file, or a crashed process left a stale lock.

**What to do.** Wait and retry; the registry retries automatically. If the lock persists with no live writer, inspect the log and checkpoint before removing the .lock file.

### audit_conflict

**Probable cause.** The audit changed between a caller's snapshot and its append (compare-and-append), or an expired lease was recorded and the decision must be re-evaluated.

**What to do.** Re-read the audit and decide again. The idempotency registry does this for you; a direct record caller should rebuild its entry against the current tail.

### audit_busy

**Probable cause.** Registry contention did not settle within 100 bounded retries.

**What to do.** Reduce concurrent writers sharing the store or retry later. No write was authorized.

### invalid_store

**Probable cause.** A custom AuditStore is missing read or append, is asynchronous, returned a Promise, or returned something other than an array.

**What to do.** Implement synchronous read() returning detached entries in order and atomic append(entry, expectedLength) returning void. Asynchronous stores are outside this API.

### protected_admission

**Probable cause.** Public record or a direct store append tried to write claim, lease, policy, or duplicate lifecycle state.

**What to do.** Use the idempotency registry (claim, dispatch, release, complete) or the SDK executor. Lifecycle state cannot be recorded from wire data.

## Claims, dispatch, policy, and completion (idempotency registry)

### invalid_claim_ttl

**Probable cause.** The registry TTL is not an integer between 1 millisecond and 30 days.

**What to do.** Configure claimTtlMs within that range. TTL only frees unused reservations; it never makes a dispatched write retryable.

### invalid_clock

**Probable cause.** The registry clock option is not a function or returned an invalid Unix timestamp.

**What to do.** Pass a function returning milliseconds since the epoch, or omit it to use Date.now.

### invalid_policy

**Probable cause.** The write policy is malformed: rules or rateLimits are not arrays, a rule ID is missing, duplicated, or not an opaque identifier, an effect is not allow or block, a surface is unregistered, an account is not an exact identifier, or a rate limit has a negative budget or non-positive window.

**What to do.** Fix the host-owned policy configuration. Rule IDs must be unique opaque identifiers (no URLs or secrets). Policy is never accepted from a tool call.

### stale_claim

**Probable cause.** The supplied lease does not match the current lease for its action (wrong token, fence, expiry, or identity), the action was reclaimed by another owner, or no matching dispatched claim exists for completion.

**What to do.** Obtain a new claim; never reuse an old lease. After a restart, complete through completeVerified or the SDK's reconcile, which rely on the audited dispatch and binding instead of the token.

### claim_expired

**Probable cause.** An unused reservation passed its TTL before dispatch or release.

**What to do.** Claim again (the new lease has a higher fence) and dispatch promptly. Nothing was written.

### claim_dispatched

**Probable cause.** dispatch or release was called on a lease that already recorded dispatch.

**What to do.** A dispatched write may have reached the destination. Read it back and bind it; it can never be released or dispatched again.

### claim_not_dispatched

**Probable cause.** complete was called for a reservation that never recorded dispatch, or (as a warning on receipts.observe) a destination was observed for an action whose live reservation was never dispatched: the write bypassed dispatch and its budget.

**What to do.** Dispatch immediately before the outward write. If no write happened, release the reservation instead of completing it.

### policy_denied

**Probable cause.** The configured write policy refused the action: a matching block rule, an unmatched allow-list under defaultEffect block (ruleId default-policy), or an exhausted rate budget. Returned by claim and dispatch, thrown by the SDK as PolicyDeniedError, and audited as a named decision.

**What to do.** Inspect ruleId. Adjust the host policy, choose a permitted account or surface, or wait for the rate window. Release an unused reservation (the SDK does this). No write was made and no budget was consumed.

### active_claim

**Probable cause.** DUPLICATE reason: another live (unexpired, unreleased) reservation holds this account and action. Nothing has been written yet.

**What to do.** Wait for that owner to dispatch, release, or expire, then claim again if the write is still wanted. Do not write, do not observe a destination that does not exist, and do not mint a new actionId to work around the reservation.

### dispatched

**Probable cause.** DUPLICATE reason: this account and action already recorded a possible write (a dispatched attempt or an observed object), so no second execution is possible.

**What to do.** Reconcile the existing attempt: read the destination back with the original attemptId and bind it. Changing the payload, attempt ID, or idempotency key does not evade this.

### completed

**Probable cause.** DUPLICATE reason: this account and action already completed with an audited binding.

**What to do.** Report the existing receipt. A separately approved action needs a new actionId and approvalId.

### approval_reused

**Probable cause.** The approvalId was already spent on a different action for this account, by a possible write or a reservation that is not durably released or expired. Returned as a DUPLICATE reason at claim, thrown at dispatch, and rejected by the audit validator when a chain holds possible writes for two actions under one approval.

**What to do.** Request a separate approval per write: each approval ID authorizes exactly one action. Nothing was written for this action. If the earlier action was abandoned, release its reservation (or let it expire) before reusing the approval.

## Destination connector reads

### invalid_connector

**Probable cause.** observeDestination received something without a read function or whose surface differs from the request.

**What to do.** Configure a trusted local connector for the exact surface at startup. Connectors are never deserialized from requests.

### connector_read_failed

**Probable cause.** The connector threw while reading the destination (network, credentials, timeout, or an unexpected response). The provider's error text is deliberately discarded.

**What to do.** Check local credentials and connectivity, then read again. The outcome remains unverified; never repeat the write.

### account_mismatch

**Probable cause.** The connector read, or is configured for, a different destination account than the request names.

**What to do.** Use the connector configured for the exact destinationAccount. A renamed or transferred destination fails closed.

### object_mismatch

**Probable cause.** The connector read a different object than requested, the locator and destinationId disagree, the observed record does not match the requested repository and object, an immutable ID changed, or a completed action was asked to switch objects.

**What to do.** Supply the exact observed destinationId or its locator. Do not reuse an ID from another object.

### attempt_mismatch

**Probable cause.** observeDestination or receipts.observe/recheck was asked to read an action back under an attemptId different from the attempt that dispatched or completed it. Binding under a foreign attempt would strand the dispatched lease.

**What to do.** Read the destination back with the original attemptId of the dispatched attempt. A new attempt for the same action is not a new write.

### invalid_observation

**Probable cause.** The connector returned an observation without a valid ISO timestamp.

**What to do.** Return observedAt as an ISO-8601 string from the connector's own read.

### invalid_locator

**Probable cause.** A connector locator is missing or unsafe: locator.issueNumber is not a positive safe integer, locator.path is not an absolute file path, or locator.messageId is empty.

**What to do.** Provide the locator in the surface's canonical form: a positive integer issue number, an absolute file path, or the message id from the send result. Unsafe locators are rejected before any destination read.

### invalid_timeout

**Probable cause.** A GitHub or Gmail connector's timeoutMs is outside 1 to 60000 milliseconds.

**What to do.** Configure a read timeout within that range.

## SDK executor errors

### duplicate_write_refused

**Probable cause.** DuplicateWriteError: the account and action already have an execution claim or a possible write, the approval was already spent, or another live reservation exists (the persisted decision carries the audited reason).

**What to do.** Reconcile the existing action with reconcile() and a real locator. Never execute again. A separately approved action needs a new actionId and approvalId.

### verification_pending

**Probable cause.** VerificationPendingError: claimComplete was called without a durable complete receipt bound to this approved package, the receipt does not match its persisted entry, independent proof was required but only cooperative evidence exists, or reconcile could not find exactly one matching execution claim.

**What to do.** Reconcile with the original attemptId, the same approved payload, and a real destinationId or locator. Require independent proof only when a connector is configured. Do not claim completion.

## GitHub issues connector

### invalid_github_repository

**Probable cause.** owner or repo is not a valid GitHub name.

**What to do.** Pass the exact owner and repository names; they are normalized to lowercase in the account identity.

### invalid_issue_payload

**Probable cause.** githubIssuePayload received a non-string title or a body that is neither a string nor null.

**What to do.** Pass the approved title string and body string (null becomes an empty string).

### missing_github_token

**Probable cause.** No token was configured and neither GITHUB_TOKEN nor GH_TOKEN is set locally.

**What to do.** Export GITHUB_TOKEN or GH_TOKEN in the local environment, or pass token explicitly. Tokens are sent only to api.github.com and never audited.

### github_read_failed

**Probable cause.** The GitHub read failed (network error, timeout, redirect refused) or returned a non-200 status. The response body is discarded.

**What to do.** Check the token's read permission for the repository and connectivity, then read again. No receipt was issued; do not repeat the write.

### invalid_github_response

**Probable cause.** GitHub returned a response that is not a valid issue record.

**What to do.** Read again. If it persists, verify the repository and issue exist and the API version header is supported.

### not_a_github_issue

**Probable cause.** The requested number is a pull request.

**What to do.** Use the issue number of an actual issue; pull requests are outside the GitHub issues surface.

## File connector

### staged_file_not_text

**Probable cause.** The staged file passed to receipts.prepare or stageFilePayload is not valid UTF-8 text.

**What to do.** Stage the approved content as UTF-8 text. Binary files are outside the file-write payload contract.

### invalid_file_payload

**Probable cause.** filePayload received an empty path, or content that is neither a string nor null.

**What to do.** Pass the absolute file path and the full final content string (null becomes an empty string).

### invalid_file_account

**Probable cause.** The file connector's account id is longer than 256 characters or contains control characters.

**What to do.** Configure a nonempty accountId, or set RECEIPTS_FILE_ACCOUNT locally. It must match the claim's destinationAccount.

### invalid_file_roots

**Probable cause.** The allowed roots list is empty or contains a path that is not absolute, or maxBytes is not a positive integer. Over MCP, the file connector was enabled without RECEIPTS_FILE_ROOTS.

**What to do.** Configure allowed roots as absolute paths, or set RECEIPTS_FILE_ROOTS to absolute paths separated by the platform path delimiter (':' on macOS and Linux, ';' on Windows).

### file_too_large

**Probable cause.** The file at the requested path is larger than the connector's maxBytes read limit (16 MiB by default).

**What to do.** Raise maxBytes when constructing the connector if files this large are expected. No verification was issued; never repeat the write.

## Gmail connector

### invalid_gmail_payload

**Probable cause.** canonicalGmailPayload received no To recipient, or a subject, body, cc, bcc, or html value that is not a string.

**What to do.** Pass the approved To list, subject, and plain body as strings; cc, bcc, and the HTML body are optional strings. Recipient order, case, and display names do not affect the digest.

### invalid_gmail_account

**Probable cause.** The Gmail connector's account label is empty.

**What to do.** Pass a nonempty account label, for example the mailbox address. It must match the claim's destinationAccount.

### invalid_gmail_client

**Probable cause.** No getMessage function was supplied to the Gmail connector.

**What to do.** Inject an authenticated Gmail read of the form (messageId) => users.messages.get with format=full.

## MCP server tools and startup

### connector_not_configured

**Probable cause.** receipts.observe or receipts.recheck was called for a surface that has no locally configured connector.

**What to do.** Configure the connector at startup (for GitHub set RECEIPTS_GITHUB_REPO and a local token, for Gmail set RECEIPTS_GMAIL_ACCOUNT and RECEIPTS_GMAIL_TOKEN, for files set RECEIPTS_FILE_ACCOUNT and optionally RECEIPTS_FILE_ROOTS, or pass connectors programmatically). Request data cannot install a connector.

### invalid_prepare

**Probable cause.** receipts.prepare received both payload and file, or neither.

**What to do.** Pass exactly one: payload for any surface, or file ({ source, destination }) for the file-write surface.

### file_staging_not_configured

**Probable cause.** receipts.prepare was asked to claim from a staged file, but the server started without RECEIPTS_FILE_ROOTS.

**What to do.** Restart the server with RECEIPTS_FILE_ROOTS covering the staging and destination directories, or pass the approved payload instead.

### receipt_not_found

**Probable cause.** receipts.sign or receipts.badge found no historical complete receipt for the object, digest, and scope.

**What to do.** Verify the identity with receipts.verify. Observe and bind the object first; a receipt cannot be signed before it exists.

### signing_key_not_configured

**Probable cause.** receipts.sign or receipts.badge was called but the server started without a signing key.

**What to do.** Start the server with --signing-key FILE or RECEIPTS_SIGNING_KEY_PATH pointing at a local 0600 PEM file. Generate one with generateReceiptKeyPair.

### invalid_signing_key

**Probable cause.** The configured signing key is not a PEM-encoded PKCS8 Ed25519 private key, or the proof package received a key of another type.

**What to do.** Generate a key with generateReceiptKeyPair and store its privateKey PEM in a protected local file. Never place key material in environment variables or the repository.

### badge_requires_independent_completion

**Probable cause.** A badge was requested for a receipt that is not complete or was not independently verified (cooperative evidence).

**What to do.** Only a complete receipt from a locally configured connector read can display the independent badge. Observe the destination with the connector, then request the badge for that receipt.

### invalid_receipt_url

**Probable cause.** The badge receiptUrl is not an HTTPS URL, or embeds credentials.

**What to do.** Provide an https URL without a username or password, or omit receiptUrl for a standalone badge.

### startup_failed

**Probable cause.** The MCP or REST command line could not start: an invalid option, port, transport, repository, policy file, TTL, or signing key.

**What to do.** Run with --help, fix the option or file named in the message, and start again. File contents are never printed.

### internal_error

**Probable cause.** An unexpected non-Receipts error occurred while handling a tool call or request. Its message is deliberately withheld from the response; the server writes only the error class name to its stderr.

**What to do.** Check the server's stderr locally for the error class, reproduce, then report it with `receipts bug-report`. Do not assume the operation succeeded.

## Receipts MCP client library

### client_timeout

**Probable cause.** A Receipts MCP call or the connection handshake did not answer within the client timeout (60 seconds by default). The client stopped the server process; the call returned no receipt.

**What to do.** Do not repeat an outward write. Reconnect and read the audit to learn what was recorded: receipts.verify or receipts.observe for the object, or claim again (DUPLICATE with reason dispatched means the dispatch was recorded). Raise timeoutMs only if the server is known to be slow.

### client_disconnected

**Probable cause.** The Receipts server process exited or closed its connection while a call was in flight. The call returned no receipt.

**What to do.** Check the server's stderr (startup_failed names configuration problems), reconnect, and read the audit before acting. Do not repeat an outward write.

### client_closed

**Probable cause.** A call was made on a Receipts client after it was closed, including after a timeout stopped its server.

**What to do.** Create a new client with connectReceipts and read the audit before continuing.

## REST transport

### forbidden_origin

**Probable cause.** The request's Host is not loopback or its Origin is not the same loopback origin.

**What to do.** Call the REST server from a local process using http://127.0.0.1 or http://localhost. Remote access requires a separately secured gateway.

### body_too_large

**Probable cause.** The JSON body exceeds 1 MiB.

**What to do.** Send only identifiers, digests, and evidence summaries. Payload content does not belong in requests.

### invalid_content_type

**Probable cause.** A POST did not use Content-Type: application/json.

**What to do.** Set Content-Type: application/json.

### not_found

**Probable cause.** The route does not exist.

**What to do.** Use POST /classify, /record, /bind, /observe, /recheck or GET /verify.

### invalid_input

**Probable cause.** The body is not valid JSON or a required field is missing or has the wrong type.

**What to do.** Send a JSON object with the fields documented for the endpoint.

## Signed proofs and badges

### invalid_proof

**Probable cause.** verifySignedReceipt returned valid false. The proof's format, signature, signer, receipt hash, audit chain, head, or timestamp did not verify against the trusted key. The reason is deliberately generic.

**What to do.** Obtain the proof again from its publisher and confirm the trusted public key through a separately authenticated channel. Do not accept the key embedded in the proof.

### invalid_public_key

**Probable cause.** renderReceiptBadge received a trustedPublicKey that is not an Ed25519 public key (PEM or KeyObject). verifySignedReceipt folds the same condition into its generic invalid_proof result.

**What to do.** Pass the publisher's Ed25519 SPKI public key PEM obtained from a trusted channel.

### invalid_receipt

**Probable cause.** The receipt to sign is not an exact observed receipt (missing object, identity, observation time, or reference), or contains values that cannot be canonicalized.

**What to do.** Sign only receipts returned by getReceipt, bind, or observeDestination, unmodified.

### receipt_audit_mismatch

**Probable cause.** The receipt does not match its audit entry in the exported snapshot.

**What to do.** Sign the receipt exactly as stored. An edited receipt cannot be signed.

## Conformance evaluations and certification eligibility

### assertion_failed

**Probable cause.** A benchmark case's assertion failed: the connector or SDK made a wrong decision under the fixture.

**What to do.** Read the case name and its decision results in the evaluation receipt, fix the connector, and rerun. The evaluation cannot qualify for certification.

### fixture_or_operation_failed

**Probable cause.** A benchmark case failed because the fixture factory, a state control, or an operation threw. Arbitrary error text is not copied into the evaluation.

**What to do.** Run the suite locally to see the sanitized test output, fix the fixture or connector, and rerun.

### cleanup_failed

**Probable cause.** A fixture's dispose threw after a case.

**What to do.** Make dispose idempotent and restore process-global mocks with the test context.

### invalid_evaluation_provenance

**Probable cause.** The evaluation receipt's schema version, execution mode, authority, or identity algorithm is not the supported self-attested local-fixture format.

**What to do.** Generate evaluations with connectorConformance; do not construct or edit receipts by hand.

### unsupported_benchmark

**Probable cause.** The evaluation names a different benchmark or version than this package implements.

**What to do.** Rerun the evaluation with the current conformance package.

### connector_version_required

**Probable cause.** The evaluation's connector version is unspecified.

**What to do.** Pass connectorVersion with the real connector package version when running the suite.

### evaluation_not_conformant

**Probable cause.** Cases are missing or failed, decisions were unobserved, or the recomputed calibration or summary differs from the receipt.

**What to do.** Fix the failing cases and rerun until every decision is observed with zero errors. A partial or altered receipt cannot qualify.

### published_evaluation_declaration_required

**Probable cause.** No publication declaration was supplied, its URL is not a public HTTPS URL without credentials, or its digest does not match the evaluation.

**What to do.** Publish the exact evaluation JSON at an immutable HTTPS URL and declare that URL with evaluationDigest(receipt). Publication is declared, never verified remotely.

## Claude Code plugin hook feedback

### adapter_required

**Probable cause.** The Claude Code hook saw an outward-looking tool with no registered surface mapping, so its result cannot be verified.

**What to do.** Map the exact tool name to a surface in RECEIPTS_HOOK_TOOLS and configure a destination observer. Do not retry an uncertain write or invent an ID.
