/**
 * The single source of truth for every code Receipts surfaces to a user, an agent, or an
 * operator: thrown ReceiptsError codes, SDK error classes, transport error envelopes,
 * proof and conformance result codes, and hook feedback. docs/ERRORS.md is generated from
 * this table (`npm run docs:errors`) and a core test refuses any code that appears in
 * source without an entry here. Entries describe causes and fixes; they never echo
 * payloads, identifiers, credentials, or provider messages.
 */
export type ErrorFamily = "input" | "audit" | "admission" | "connector" | "sdk" | "github" | "mcp" | "rest" | "proof" | "conformance" | "plugin";

export interface ErrorTaxonomyEntry {
  readonly code: string;
  readonly family: ErrorFamily;
  /** Where the code is produced and what it means. */
  readonly cause: string;
  /** What the caller should do. Never a retry of an uncertain write. */
  readonly fix: string;
  /** Stable anchor into docs/ERRORS.md on the main branch. */
  readonly docs: string;
}

export const ERROR_DOCS_URL = "https://github.com/77systems-ai/receipts/blob/main/docs/ERRORS.md";

export const ERROR_FAMILIES: Readonly<Record<ErrorFamily, string>> = Object.freeze({
  input: "Input validation (core classify, record, bind, verify)",
  audit: "Audit store integrity and concurrency",
  admission: "Claims, dispatch, policy, and completion (idempotency registry)",
  connector: "Destination connector reads",
  sdk: "SDK executor errors",
  github: "GitHub issues connector",
  mcp: "MCP server tools and startup",
  rest: "REST transport",
  proof: "Signed proofs and badges",
  conformance: "Conformance evaluations and certification eligibility",
  plugin: "Claude Code plugin hook feedback",
});

const table: Readonly<Record<string, readonly [ErrorFamily, string, string]>> = {
  // ---- input ---------------------------------------------------------------
  invalid_write: ["input",
    "An outward write or SDK execute option is missing, or an identity field (attemptId, destinationAccount, approvalId, idempotencyKey, statusFlag) is empty, unbounded, has surrounding whitespace or control characters, or a flag is not a boolean.",
    "Supply a nonempty attemptId, opaque identifiers of at most 256 characters without surrounding whitespace, and boolean flags. Never place payload text or secrets in identifier fields."],
  invalid_digest: ["input",
    "A packageDigest, boundPackageDigest, observed digest, or evidence digest is not a lowercase `sha256:` hex digest of 64 characters.",
    "Hash the exact approved payload with the SDK's digestPayload (canonical JSON) or core's digestPackage (exact bytes). Do not substitute a provider token or an observed digest for the approved one."],
  invalid_payload: ["input",
    "digestPackage received something other than a string or bytes, or the SDK / receipts.digest received a value that is not plain JSON (undefined, NaN, Infinity, BigInt, cycles, sparse arrays, getters, class instances, symbol keys).",
    "Serialize structured payloads first, or pass plain JSON values only. The SDK rejects ambiguous inputs instead of silently coercing them."],
  invalid_action_id: ["input",
    "actionId is not a UUID.",
    "Generate one UUID per approved logical action, persist it, and reuse it on uncertain retries. A separately approved action needs a new UUID."],
  invalid_destination_id: ["input",
    "destinationId is empty, has surrounding whitespace, or does not match the registered surface's ID pattern.",
    "Pass the exact identifier observed at the destination in the surface's canonical form. Never invent or normalize an ID to make it fit."],
  invalid_evidence: ["input",
    "An evidence item lacks a recognized source (provider, human, executor, binding) or a nonempty detail, or has a malformed observedAt, destinationId, reference, or digest.",
    "Provide evidence with a recognized source, a nonempty summary, and valid timestamps and digests. Freeform detail is hashed, never stored."],
  invalid_rearm: ["input",
    "A rearm object is malformed, or rearming was attempted without an audited prewrite attempt carrying the previous digest and affirmative never-reached evidence.",
    "Record the failed prewrite attempt with neverReached true first. Rearm only after a fixed cause, with a new digest and a new attempt ID."],
  invalid_surface: ["input",
    "registerSurface received a name that is not lowercase-hyphenated, an idPattern that is not a RegExp, or a non-function observer.",
    "Register surfaces from trusted startup code with a lowercase hyphenated name and a RegExp ID pattern."],
  surface_already_registered: ["input",
    "registerSurface was called twice for the same surface name in one process.",
    "Register each surface once at startup. Guard optional registrations with getSurface and catch not_a_destination_write, as the GitHub connector does."],
  not_a_destination_write: ["input",
    "The surface named in a write, action, policy rule, or connector request is not registered in this process. Unknown surfaces are rejected, never guessed; this is an error code, not a fifth verdict.",
    "Register the surface locally before classifying or claiming, or import the connector package that registers it (for GitHub, @77systems/receipts-github)."],
  invalid_entry: ["input",
    "An audit entry violates a structural or lifecycle rule: its verdict contradicts its evidence, its ID is not a UUID, an attempt changed surface, digest, identity, or idempotency key, an observation lacks provider or human evidence for the exact object, a binding's provenance does not match its observation, or lease metadata is inconsistent.",
    "Build entries with createAuditEntry and let core derive verdicts. Reuse the original action identity across an attempt. Do not hand-edit entries or lease metadata."],
  duplicate_entry: ["input",
    "An entry with the same ID is already recorded.",
    "Create a fresh entry with a new UUID. Do not re-append a stored entry."],
  duplicate_attempt: ["input",
    "A new execution attempt was recorded for an account and action that already has a possible write under another attempt.",
    "Reconcile the existing attempt by reading the destination and binding it. Never start a second write for the same approved action."],
  ambiguous_destination: ["input",
    "The object and digest match more than one account, action, surface, or attempt, or a new observation of this object and digest belongs to another attempt.",
    "Supply destinationAccount and actionId (and surface or attemptId when needed) as scope, or reconcile the original attempt instead of creating a new one."],
  observation_required: ["input",
    "bind, recheck, completion, or a complete classification was requested without an audited observation or binding of this exact object and approved digest for the same action.",
    "Observe the destination first (a locally configured connector read, or a host observation recorded through record), then bind it. Completion is never granted without that binding."],
  not_complete: ["input",
    "assertComplete was called for a verdict other than complete.",
    "Do not claim completion. Read the destination back, bind the exact object, and re-verify."],
  action_identity_required: ["input",
    "A new durable audit entry, observation, or claim lacks actionId, destinationAccount, or approvalId.",
    "Add the caller UUID actionId, the exact destinationAccount, and the host approvalId. Legacy v0.1 entries stay readable but cannot complete new operations."],
  // ---- audit ---------------------------------------------------------------
  audit_corrupt: ["audit",
    "The JSONL log, its hash chain, or its head checkpoint failed integrity validation: a broken link, an incomplete final line, a missing log with a retained head, or an exported chain that does not validate.",
    "Stop writing. Preserve the log, its .head checkpoint, and any .lock for inspection. Never delete, truncate, or rewrite them to recover; restore from a trusted copy instead. No verdict can be trusted from a corrupt chain."],
  audit_locked: ["audit",
    "Another process holds the audit lock file, or a crashed process left a stale lock.",
    "Wait and retry; the registry retries automatically. If the lock persists with no live writer, inspect the log and checkpoint before removing the .lock file."],
  audit_conflict: ["audit",
    "The audit changed between a caller's snapshot and its append (compare-and-append), or an expired lease was recorded and the decision must be re-evaluated.",
    "Re-read the audit and decide again. The idempotency registry does this for you; a direct record caller should rebuild its entry against the current tail."],
  audit_busy: ["audit",
    "Registry contention did not settle within 100 bounded retries.",
    "Reduce concurrent writers sharing the store or retry later. No write was authorized."],
  invalid_store: ["audit",
    "A custom AuditStore is missing read or append, is asynchronous, returned a Promise, or returned something other than an array.",
    "Implement synchronous read() returning detached entries in order and atomic append(entry, expectedLength) returning void. Asynchronous stores are outside this API."],
  protected_admission: ["audit",
    "Public record or a direct store append tried to write claim, lease, policy, or duplicate lifecycle state.",
    "Use the idempotency registry (claim, dispatch, release, complete) or the SDK executor. Lifecycle state cannot be recorded from wire data."],
  // ---- admission -----------------------------------------------------------
  invalid_claim_ttl: ["admission",
    "The registry TTL is not an integer between 1 millisecond and 30 days.",
    "Configure claimTtlMs within that range. TTL only frees unused reservations; it never makes a dispatched write retryable."],
  invalid_clock: ["admission",
    "The registry clock option is not a function or returned an invalid Unix timestamp.",
    "Pass a function returning milliseconds since the epoch, or omit it to use Date.now."],
  invalid_policy: ["admission",
    "The write policy is malformed: rules or rateLimits are not arrays, a rule ID is missing, duplicated, or not an opaque identifier, an effect is not allow or block, a surface is unregistered, an account is not an exact identifier, or a rate limit has a negative budget or non-positive window.",
    "Fix the host-owned policy configuration. Rule IDs must be unique opaque identifiers (no URLs or secrets). Policy is never accepted from a tool call."],
  stale_claim: ["admission",
    "The supplied lease does not match the current lease for its action (wrong token, fence, expiry, or identity), the action was reclaimed by another owner, or no matching dispatched claim exists for completion.",
    "Obtain a new claim; never reuse an old lease. After a restart, complete through completeVerified or the SDK's reconcile, which rely on the audited dispatch and binding instead of the token."],
  claim_expired: ["admission",
    "An unused reservation passed its TTL before dispatch or release.",
    "Claim again (the new lease has a higher fence) and dispatch promptly. Nothing was written."],
  claim_dispatched: ["admission",
    "dispatch or release was called on a lease that already recorded dispatch.",
    "A dispatched write may have reached the destination. Read it back and bind it; it can never be released or dispatched again."],
  claim_not_dispatched: ["admission",
    "complete was called for a reservation that never recorded dispatch, for example an agent that observed a destination without calling dispatch first.",
    "Dispatch immediately before the outward write. If no write happened, release the reservation instead of completing it."],
  policy_denied: ["admission",
    "The configured write policy refused the action: a matching block rule, an unmatched allow-list under defaultEffect block (ruleId default-policy), or an exhausted rate budget. Returned by claim and dispatch, thrown by the SDK as PolicyDeniedError, and audited as a named decision.",
    "Inspect ruleId. Adjust the host policy, choose a permitted account or surface, or wait for the rate window. Release an unused reservation (the SDK does this). No write was made and no budget was consumed."],
  // DUPLICATE decisions carry one of these reasons in decision.reason and the audit.
  active_claim: ["admission",
    "DUPLICATE reason: another live (unexpired, unreleased) reservation holds this account and action.",
    "Wait for that owner to dispatch, release, or expire. Do not write; do not create a new action to work around the reservation."],
  dispatched: ["admission",
    "DUPLICATE reason: this account and action already recorded a possible write (a dispatched attempt or an observed object), so no second execution is possible.",
    "Reconcile the existing attempt: read the destination back with the original attemptId and bind it. Changing the payload, attempt ID, or idempotency key does not evade this."],
  completed: ["admission",
    "DUPLICATE reason: this account and action already completed with an audited binding.",
    "Report the existing receipt. A separately approved action needs a new actionId and approvalId."],
  approval_reused: ["admission",
    "DUPLICATE reason: the approvalId was already spent on a different action for this account, by a possible write or a live reservation. Released or expired unused reservations do not spend an approval.",
    "Obtain a new approval for the new action. If the earlier action was abandoned, release its reservation (or let it expire) and claim again."],
  // ---- connector -----------------------------------------------------------
  invalid_connector: ["connector",
    "observeDestination received something without a read function or whose surface differs from the request.",
    "Configure a trusted local connector for the exact surface at startup. Connectors are never deserialized from requests."],
  connector_read_failed: ["connector",
    "The connector threw while reading the destination (network, credentials, timeout, or an unexpected response). The provider's error text is deliberately discarded.",
    "Check local credentials and connectivity, then read again. The outcome remains unverified; never repeat the write."],
  account_mismatch: ["connector",
    "The connector read, or is configured for, a different destination account than the request names.",
    "Use the connector configured for the exact destinationAccount. A renamed or transferred destination fails closed."],
  object_mismatch: ["connector",
    "The connector read a different object than requested, the locator and destinationId disagree, the observed record does not match the requested repository and object, an immutable ID changed, or a completed action was asked to switch objects.",
    "Supply the exact observed destinationId or its locator. Do not reuse an ID from another object."],
  invalid_observation: ["connector",
    "The connector returned an observation without a valid ISO timestamp.",
    "Return observedAt as an ISO-8601 string from the connector's own read."],
  // ---- sdk -----------------------------------------------------------------
  duplicate_write_refused: ["sdk",
    "DuplicateWriteError: the account and action already have an execution claim or a possible write, the approval was already spent, or another live reservation exists (the persisted decision carries the audited reason).",
    "Reconcile the existing action with reconcile() and a real locator. Never execute again. A separately approved action needs a new actionId and approvalId."],
  verification_pending: ["sdk",
    "VerificationPendingError: claimComplete was called without a durable complete receipt bound to this approved package, the receipt does not match its persisted entry, independent proof was required but only cooperative evidence exists, or reconcile could not find exactly one matching execution claim.",
    "Reconcile with the original attemptId, the same approved payload, and a real destinationId or locator. Require independent proof only when a connector is configured. Do not claim completion."],
  // ---- github --------------------------------------------------------------
  invalid_github_repository: ["github",
    "owner or repo is not a valid GitHub name.",
    "Pass the exact owner and repository names; they are normalized to lowercase in the account identity."],
  invalid_issue_payload: ["github",
    "githubIssuePayload received a non-string title or a body that is neither a string nor null.",
    "Pass the approved title string and body string (null becomes an empty string)."],
  invalid_timeout: ["github",
    "timeoutMs is outside 1 to 60000 milliseconds.",
    "Configure a read timeout within that range."],
  invalid_locator: ["github",
    "locator.issueNumber is missing when no destinationId was supplied, or is not a positive safe integer.",
    "Provide a positive integer issue number, or the previously observed github:issue destinationId. Unsafe locators are rejected before credentials are used."],
  missing_github_token: ["github",
    "No token was configured and neither GITHUB_TOKEN nor GH_TOKEN is set locally.",
    "Export GITHUB_TOKEN or GH_TOKEN in the local environment, or pass token explicitly. Tokens are sent only to api.github.com and never audited."],
  github_read_failed: ["github",
    "The GitHub read failed (network error, timeout, redirect refused) or returned a non-200 status. The response body is discarded.",
    "Check the token's read permission for the repository and connectivity, then read again. No receipt was issued; do not repeat the write."],
  invalid_github_response: ["github",
    "GitHub returned a response that is not a valid issue record.",
    "Read again. If it persists, verify the repository and issue exist and the API version header is supported."],
  not_a_github_issue: ["github",
    "The requested number is a pull request.",
    "Pull requests are outside the GitHub issues surface. Use the issue number of an actual issue."],
  // ---- mcp -----------------------------------------------------------------
  connector_not_configured: ["mcp",
    "receipts.observe or receipts.recheck was called for a surface that has no locally configured connector.",
    "Configure the connector at startup (for GitHub set RECEIPTS_GITHUB_REPO and a local token, or pass connectors programmatically). Request data cannot install a connector."],
  receipt_not_found: ["mcp",
    "receipts.sign or receipts.badge found no historical complete receipt for the object, digest, and scope.",
    "Verify the identity with receipts.verify. Observe and bind the object first; a receipt cannot be signed before it exists."],
  signing_key_not_configured: ["mcp",
    "receipts.sign or receipts.badge was called but the server started without a signing key.",
    "Start the server with --signing-key FILE or RECEIPTS_SIGNING_KEY_PATH pointing at a local 0600 PEM file. Generate one with generateReceiptKeyPair."],
  invalid_signing_key: ["mcp",
    "The configured signing key is not a PEM-encoded PKCS8 Ed25519 private key, or the proof package received a key of another type.",
    "Generate a key with generateReceiptKeyPair and store its privateKey PEM in a protected local file. Never place key material in environment variables or the repository."],
  badge_requires_independent_completion: ["mcp",
    "A badge was requested for a receipt that is not complete or was not independently verified (cooperative evidence).",
    "Only a complete receipt from a locally configured connector read can display the independent badge. Observe the destination with the connector, then request the badge for that receipt."],
  invalid_receipt_url: ["mcp",
    "The badge receiptUrl is not an HTTPS URL, or embeds credentials.",
    "Provide an https URL without a username or password, or omit receiptUrl for a standalone badge."],
  startup_failed: ["mcp",
    "The MCP or REST command line could not start: an invalid option, port, transport, repository, policy file, TTL, or signing key.",
    "Run with --help, fix the option or file named in the message, and start again. File contents are never printed."],
  internal_error: ["mcp",
    "An unexpected non-Receipts error occurred while handling a tool call or request. Its message is deliberately withheld from the response.",
    "Check the server's stderr locally, then report it with `receipts bug-report`. Do not assume the operation succeeded."],
  // ---- rest ----------------------------------------------------------------
  forbidden_origin: ["rest",
    "The request's Host is not loopback or its Origin is not the same loopback origin.",
    "Call the REST server from a local process using http://127.0.0.1 or http://localhost. Remote access requires a separately secured gateway."],
  body_too_large: ["rest",
    "The JSON body exceeds 1 MiB.",
    "Send only identifiers, digests, and evidence summaries. Payload content does not belong in requests."],
  invalid_content_type: ["rest",
    "A POST did not use Content-Type: application/json.",
    "Set Content-Type: application/json."],
  not_found: ["rest",
    "The route does not exist.",
    "Use POST /classify, /record, /bind, /observe, /recheck or GET /verify."],
  invalid_input: ["rest",
    "The body is not valid JSON or a required field is missing or has the wrong type.",
    "Send a JSON object with the fields documented for the endpoint."],
  // ---- proof ---------------------------------------------------------------
  invalid_proof: ["proof",
    "verifySignedReceipt returned valid false. The proof's format, signature, signer, receipt hash, audit chain, head, or timestamp did not verify against the trusted key. The reason is deliberately generic.",
    "Obtain the proof again from its publisher and confirm the trusted public key through a separately authenticated channel. Do not accept the key embedded in the proof."],
  invalid_public_key: ["proof",
    "The trusted public key is not an Ed25519 public key (PEM or KeyObject).",
    "Pass the publisher's Ed25519 SPKI public key PEM obtained from a trusted channel."],
  invalid_receipt: ["proof",
    "The receipt to sign is not an exact observed receipt (missing object, identity, observation time, or reference), or contains values that cannot be canonicalized.",
    "Sign only receipts returned by getReceipt, bind, or observeDestination, unmodified."],
  receipt_audit_mismatch: ["proof",
    "The receipt does not match its audit entry in the exported snapshot.",
    "Sign the receipt exactly as stored. An edited receipt cannot be signed."],
  // ---- conformance ---------------------------------------------------------
  assertion_failed: ["conformance",
    "A benchmark case's assertion failed: the connector or SDK made a wrong decision under the fixture.",
    "Read the case name and its decision results in the evaluation receipt, fix the connector, and rerun. The evaluation cannot qualify for certification."],
  fixture_or_operation_failed: ["conformance",
    "A benchmark case failed because the fixture factory, a state control, or an operation threw. Arbitrary error text is not copied into the evaluation.",
    "Run the suite locally to see the sanitized test output, fix the fixture or connector, and rerun."],
  cleanup_failed: ["conformance",
    "A fixture's dispose threw after a case.",
    "Make dispose idempotent and restore process-global mocks with the test context."],
  invalid_evaluation_provenance: ["conformance",
    "The evaluation receipt's schema version, execution mode, authority, or identity algorithm is not the supported self-attested local-fixture format.",
    "Generate evaluations with connectorConformance; do not construct or edit receipts by hand."],
  unsupported_benchmark: ["conformance",
    "The evaluation names a different benchmark or version than this package implements.",
    "Rerun the evaluation with the current conformance package."],
  connector_version_required: ["conformance",
    "The evaluation's connector version is unspecified.",
    "Pass connectorVersion with the real connector package version when running the suite."],
  evaluation_not_conformant: ["conformance",
    "Cases are missing or failed, decisions were unobserved, or the recomputed calibration or summary differs from the receipt.",
    "Fix the failing cases and rerun until every decision is observed with zero errors. A partial or altered receipt cannot qualify."],
  published_evaluation_declaration_required: ["conformance",
    "No publication declaration was supplied, its URL is not a public HTTPS URL without credentials, or its digest does not match the evaluation.",
    "Publish the exact evaluation JSON at an immutable HTTPS URL and declare that URL with evaluationDigest(receipt). Publication is declared, never verified remotely."],
  // ---- plugin --------------------------------------------------------------
  adapter_required: ["plugin",
    "The Claude Code hook saw an outward-looking tool with no registered surface mapping, so its result cannot be verified.",
    "Map the exact tool name to a surface in RECEIPTS_HOOK_TOOLS and configure a destination observer. Do not retry an uncertain write or invent an ID."],
};

export const ERROR_TAXONOMY: Readonly<Record<string, ErrorTaxonomyEntry>> = Object.freeze(Object.fromEntries(
  Object.entries(table).map(([code, [family, cause, fix]]) =>
    [code, Object.freeze({ code, family, cause, fix, docs: `${ERROR_DOCS_URL}#${code}` })]),
));

/** Look up the documented cause and fix for a code. Unknown codes return undefined; they are a bug. */
export function describeError(code: string): ErrorTaxonomyEntry | undefined {
  return Object.hasOwn(ERROR_TAXONOMY, code) ? ERROR_TAXONOMY[code] : undefined;
}

/** Renders docs/ERRORS.md. Pure; the repository script writes the file. */
export function renderErrorTaxonomyMarkdown(): string {
  const lines: string[] = [
    "# Receipts error taxonomy",
    "",
    "Generated from `packages/core/src/errors.ts` by `npm run docs:errors`; do not edit by hand. Every code Receipts returns, throws, audits, or prints maps to one entry here, and a core test refuses source code that introduces a code without one. Programmatic access: `describeError(code)` from `@77systems/receipts-core`.",
    "",
    "Two rules hold for every entry: no fix ever repeats an uncertain outward write, and no message ever contains payload content, credentials, or raw provider errors. SDK argument and payload validation raise `TypeError` values that carry a `code` property from this table (`invalid_write`, `invalid_payload`).",
    "",
  ];
  for (const [family, title] of Object.entries(ERROR_FAMILIES) as [ErrorFamily, string][]) {
    const entries = Object.values(ERROR_TAXONOMY).filter((entry) => entry.family === family);
    if (!entries.length) continue;
    lines.push(`## ${title}`, "");
    for (const entry of entries) {
      lines.push(`### ${entry.code}`, "", `**Probable cause.** ${entry.cause}`, "", `**Suggested fix.** ${entry.fix}`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
