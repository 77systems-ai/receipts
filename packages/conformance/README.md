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

## Calibration

Calibration scores concrete decisions before the corresponding assertions, so an unsafe complete result contributes to a measured error even though its test fails. Rates are `errors / denominator`; the denominator counts only observed decisions. `planned` and `unobserved` expose missing coverage, and an empty denominator produces `rate: null`.

| Measure | Decision opportunities in a complete run | Error being counted |
| --- | ---: | --- |
| `falseComplete` | 6 | Completion accepted for uncertain delivery, wrong account, edited content, or a timed-out read; forged evidence accepted as independent; edited recheck accepted as complete |
| `falseBlock` | 4 | Legitimate lost-response recovery, a newly approved repeated action, an unchanged recheck, or the historical original receipt incorrectly refused |
| `unsafeDispatch` | 3 | A duplicate or recycled approval reaches a second write |

Forged cooperative evidence may legitimately have a cooperative `complete` verdict. That case specifically measures whether it is incorrectly accepted as **independently verified**. Independent reads of edited content may have `independentlyVerified: true` and `package_unverified`; that is a correct rejection of completion.

A result conforms only when all required cases pass, every planned decision was measured, and all three error counts are zero. These small fixed denominators describe the benchmark, not statistically estimated production reliability. Every connector must also pass provider-specific response-validation tests.

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
