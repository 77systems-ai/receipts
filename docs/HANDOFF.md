# Receipts v0.3 handoff

v0.2 was merged before this work. The v0.3 source implements all five approved items: atomic fenced claim lifecycle, named policy/rate denials, local Ed25519 signed receipts and offline badges, scored conformance evaluation receipts, and optional OpenTelemetry wrappers.

Start with README.md and `npm ci && npm test`. New admission outcomes are separate from the four destination verdicts. TTL only frees unused reservations; a dispatched uncertain action never becomes retryable. The SDK keeps DuplicateWriteError compatibility and adds persisted admission details plus PolicyDeniedError. Core remains dependency-free.

The real GitHub example remains explicitly gated with --live and uses synthetic issues. Audits and signed proof previews stay under ignored .receipts/. The public docs/evaluations/github-0.3.0.json is a self-attested fixed-fixture benchmark, with explicit counts and denominators. It includes no audit, payloads, credentials or machine paths.

Before npm release follow docs/RELEASE.md. No npm publication, version tag, registry or marketplace submission is established by this source work. The original OS was not modified.
