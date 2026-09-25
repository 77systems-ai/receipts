# Receipts connector conformance

Benchmark **receipts-connector-conformance 2.0.0** tests the real connector implementation against a controllable provider fixture. Every run emits a structured evaluation receipt with the benchmark and connector versions, environment and seed, all case results, and measured calibration. This is a self-attested result under fixed fixtures, not an independent certification authority or proof of a live delivery.

```ts
import { connectorConformance } from "@77systems/receipts-conformance";

connectorConformance("my provider", (context) => ({
  connector,                 // Real connector using a mocked provider transport.
  payload: approvedPayload,  // Exactly the JSON payload the connector hashes.
  destinationAccount: "provider:account",
  destinationId: "provider:account:object-1",
  locator: { number: 1 },
  write: () => fixture.acceptWrite(),
  writes: () => fixture.writeCount,
  reads: () => fixture.readCount,
  changeContent: () => fixture.editExistingObject(),
  setWrongAccount: () => fixture.respondFromOtherAccount(),
  setReadFailure: (message) => fixture.failRead(message),
  dispose: () => fixture.restore(),
}), {
  connectorVersion: "0.3.0",
  seed: "provider-0.3.0",
  evaluationPath: "artifacts/provider-evaluation.json",
});
```

The third argument is optional for existing integrations. Always supply the actual connector package version before publishing an evaluation; an omitted version is recorded as `unspecified` and cannot qualify for certification.

The default output is `.receipts/evaluations/<connector>-<seeded-id>.json`. An explicit `onEvaluation(receipt)` sink can replace the default file or run alongside an explicit `evaluationPath`. The sink may return a promise. Nothing is sent over the network. Repeated runs with the same connector name, version, and seed replace that result file; choose a separate output path per run if you need run history. Evaluation files are not the destination audit log.

## Reproducibility and case results

The seed drives actual action, attempt, approval, and case identities through SHA-256; it is not merely a label attached to random UUIDs. The same seed, environment, and outcomes produce identical evaluation JSON. Provenance records only Node version, operating-system platform, CPU architecture, seed, identity algorithm, and the fact that execution used local controlled fixtures. It excludes usernames, hostnames, paths, payload content, credentials, and raw errors. User-supplied connector/version/seed identifiers should likewise contain no secrets.

All seven cases are retained in fixed order, including failed and unexecuted cases. Failures carry a fixed code (`assertion_failed`, `fixture_or_operation_failed`, or `cleanup_failed`); arbitrary exception text and stack traces are not copied. Decisions that were not reached are `unobserved`, not counted as successes. Node's suite teardown emits the receipt even when tests fail. An interrupted or killed process cannot guarantee file emission; treat a missing receipt as unevaluated.

The fixture factory runs once per test and receives Node's `TestContext`. It may be asynchronous. State controls and `dispose` may return promises. `dispose` runs after each case and its failure marks that case failed. Tests run sequentially inside each suite. Restore process-global mocks with `context.after` or `dispose`.

| Case | Scored decisions (kind) |
| --- | --- |
| `lost-response` | `uncertain-completion` (false-complete), `duplicate-dispatch` (unsafe-dispatch), `recovered-completion` (false-block) |
| `wrong-account` | `wrong-account-completion` (false-complete) |
| `changed-content` | `edited-completion` (false-complete) |
| `timeout` | `timeout-completion` (false-complete), `timeout-duplicate-dispatch` (unsafe-dispatch) |
| `forged-evidence` | `forged-independent-completion` (false-complete) |
| `reapproved-content` | `recycled-approval-dispatch` (unsafe-dispatch), `new-approval-dispatch` (false-block) |
| `recheck-history` | `unchanged-recheck-completion` (false-block), `edited-recheck-completion` (false-complete), `historical-completion` (false-block) |

A false-block decision expects `accept`; every other decision expects `reject`. `accept` means the named decision was permitted, not necessarily that a destination write occurred.

## Calibration

Calibration scores concrete decisions before the corresponding assertions, so an unsafe complete result contributes to a measured error even though its test fails. Rates are `errors / denominator`; the denominator counts only observed decisions. `planned` and `unobserved` expose missing coverage, and an empty denominator produces `rate: null`.

| Measure | Decision opportunities in a complete run | Error being counted |
| --- | ---: | --- |
| `falseComplete` | 6 | Completion accepted for uncertain delivery, wrong account, edited content, or a timed-out read; forged evidence accepted as independent; edited recheck accepted as complete |
| `falseBlock` | 4 | Legitimate lost-response recovery, a newly approved repeated action, an unchanged recheck, or the historical original receipt incorrectly refused |
| `unsafeDispatch` | 3 | A duplicate after a lost response or a timed-out read, or a recycled approval, reaches a second write |

Forged cooperative evidence may legitimately have a cooperative `complete` verdict. That case specifically measures whether it is incorrectly accepted as **independently verified**. Independent reads of edited content may have `independentlyVerified: true` and `package_unverified`; that is a correct rejection of completion.

A result conforms only when all required cases pass, every planned decision was measured, and all three error counts are zero. These small fixed denominators describe the benchmark, not statistically estimated production reliability. Every connector must also pass provider-specific response-validation tests.

## API

### `connectorConformance(name, factory, options?)`

Registers one `describe` block with seven sequential `it` cases in the current `node:test` file and returns nothing. Call it at the top level of a test file that runs under `node --test` (or `tsx --test`), once per connector. `name` is the connector's display name and becomes `connector.name` in the receipt. Each case builds a fresh in-memory audit store and an SDK client around `fixture.connector`, executes an approved write whose callback calls `fixture.write()` and then throws a private marker, and drives the scenario through `reconcile`, `recheck`, and direct core calls. The suite asserts that the marker never reaches the audit.

A failing case throws `Conformance case failed: <case>. See its sanitized evaluation receipt.`; a failing `dispose` throws `Conformance cleanup failed: <case>.` and marks that case `cleanup_failed`. The original exception text is never rethrown or written, because provider errors can contain payloads or tokens. The receipt is still emitted from the suite's `after` hook. An invalid `name`, `seed`, or `connectorVersion` (empty, longer than 200 characters, or containing control characters) throws a `TypeError` when the receipt is built.

### `ConnectorFixture` and `ConnectorFixtureFactory`

The factory `(context: TestContext) => ConnectorFixture | Promise<ConnectorFixture>` runs once per case with Node's test context. The fixture drives the real connector against a mocked provider transport; its controls must change what the provider returns, never rewrite receipts.

| Member | Contract |
| --- | --- |
| `connector` | The real `DestinationConnector` under test, reading from the mocked transport. |
| `payload` | Exactly the JSON value the connector's read digests with `digestPayload`. |
| `destinationAccount` | The exact account the connector must report. |
| `destinationId` | The object ID the connector must report after `write()`; it must match the surface's `idPattern`. |
| `locator?` | Optional read-back coordinates passed to `reconcile` and `recheck`; never audited. |
| `write()` | Make the mocked destination hold `payload` at `destinationId`, as the provider write would. |
| `writes()`, `reads()` | Exact counters of provider writes and connector reads. The cases assert precise values: one write and one read after a lost-response recovery, three reads after the recheck case, zero reads in the forged-evidence case. |
| `changeContent()` | Make subsequent reads return different content at the same object. |
| `setWrongAccount()` | Make subsequent reads report a different `destinationAccount`. |
| `setReadFailure(message)` | Make subsequent reads throw an error carrying `message`; the suite checks that this text never reaches the audit. |
| `dispose?()` | Optional cleanup after each case; a failure marks the case failed. |

All controls may return promises. The [reference fixture](tests/conformance.test.ts) is a minimal in-memory implementation.

### `ConformanceOptions`

`{ connectorVersion?, seed?, evaluationPath?, onEvaluation? }`. `connectorVersion` defaults to `unspecified`, which can never qualify for certification; supply the real package version. `seed` defaults to `receipts-conformance-v2` and drives every identity in the run. `evaluationPath` overrides the default file `.receipts/evaluations/<connector>-<seeded-id>.json`, where `<connector>` is the lowercased name with other characters replaced by `-` and `<seeded-id>` is `seededIdentity(seed, name, connectorVersion)`; the directory is created with mode 0700 and the file written with mode 0600. `onEvaluation(receipt)` receives a detached copy and may return a promise; when it is supplied without `evaluationPath`, no file is written.

### `CONFORMANCE_BENCHMARK`

The frozen `{ name: "receipts-connector-conformance", version: "2.0.0" }` recorded in every receipt and required by `assessCertification`. Compare a stored receipt's `benchmark` against it before interpreting its calibration layout.

### `seededIdentity(seed, caseName, purpose)`

Pure. Returns a UUID-formatted identifier derived from the SHA-256 of the three strings: the first 16 bytes with the version and variant bits set. The suite uses it for case IDs and for action, attempt, and approval identities, so identical seeds reproduce identical receipts. It never throws.

```ts
seededIdentity("provider-0.3.0", "lost-response", "identity-0"); // The first action ID of that case under that seed.
```

### `EvaluationReceipt`

The emitted document, `schemaVersion: "receipts-evaluation-v1"`:

- `benchmark`: `{ name, version }`, equal to `CONFORMANCE_BENCHMARK`.
- `connector`: `{ name, version }` from the call site; `version` is `unspecified` when omitted.
- `provenance`: `environment: { node, platform, arch }`, `seed`, `idGeneration: "sha256-seed-case-purpose-v1"`, `execution: "local-controlled-fixture"`, `authority: "self-attested"`.
- `cases`: seven `CaseResult` entries in benchmark order: `{ id, name, status: "passed" | "failed" | "not-run", failureCode?, decisions }`, each decision `{ name, kind, expected, observed }` with `observed` one of `accept`, `reject`, or `unobserved`.
- `calibration`: `falseComplete`, `falseBlock`, and `unsafeDispatch`, each `{ errors, denominator, planned, unobserved, rate }` with `rate: null` when nothing was observed.
- `summary`: `{ passed, failed, notRun, complete, conforms }`. `complete` requires the case manifest to match the benchmark for the seed, no `not-run` case, and no unobserved decision. `conforms` requires `complete`, every case passed, and zero errors in all three measures.

### `evaluationDigest(receipt)`

Pure. Returns `sha256:` plus the hex SHA-256 of the receipt's canonical JSON (sorted keys). Use it to name the exact artifact you published; any change to the receipt changes the digest.

### `assessCertification(receipt, publication?)`

Local eligibility check for a “Receipts Certified” claim. It recomputes calibration and summary from the receipt's own cases, checks the benchmark and provenance constants, and compares the declared publication against the receipt's digest. It returns `{ eligible, publicationDeclared, publicationVerified: false, evaluationDigest, reasons }`; `eligible` is true only when `reasons` is empty. Reasons: `invalid_evaluation_provenance`, `unsupported_benchmark`, `connector_version_required`, `evaluation_not_conformant` (a recomputed calibration or summary that differs, an incomplete manifest, or any failure), and `published_evaluation_declaration_required` (no publication, a non-HTTPS URL, embedded credentials, a loopback host, or a digest mismatch). It makes no request; `publicationVerified` is always `false`. A structurally malformed receipt throws; an unparsable URL string does not throw, it is simply not a declaration.

## Published evaluations and “Receipts Certified”

“Receipts Certified” requires publishing the complete evaluation receipt for the stated connector version. Publishing is an explicit operator action. Prefer an immutable artifact URL, such as a commit-pinned repository URL. This package never publishes an evaluation automatically.

```ts
import { assessCertification, evaluationDigest } from "@77systems/receipts-conformance";

const eligibility = assessCertification(evaluation, {
  url: "https://example.com/published/provider-evaluation.json",
  digest: evaluationDigest(evaluation),
});
// eligibility.eligible requires a conforming, complete evaluation and publication declaration.
// publicationDeclared: true; publicationVerified: false (no network request is made).
```

The assessment recalculates calibration and checks the full benchmark case manifest. Missing cases, unobserved decisions, failing cases, altered summary counts, an unspecified connector version, a missing publication declaration, or a mismatched digest cannot qualify. A supplied URL is a declaration by the publisher; the assessment does not establish that the URL is public, reachable, or controlled by an independent authority. Review the published artifact before displaying the certification claim.

The repository's [GitHub 0.3.0 evaluation](../../docs/evaluations/github-0.3.0.json) is generated by running this benchmark against the actual GitHub connector with its provider transport mocked. The separate [GitHub live example](../../examples/github-issues) verifies lost-response recovery against the real API and saves inspectable destination receipts locally.
