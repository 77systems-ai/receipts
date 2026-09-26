# v0.4 release checklist

Source repository: https://github.com/77systems-ai/receipts

v0.4.0 adds the fifteen-tool MCP surface (admission, one-call prepare, policy, digests, signed proofs), the deadline-bound MCP client, the support CLI, the error taxonomy, and the file-write and Gmail send example connectors to the v0.3 admission, proof, conformance, and OTel work. Publishing npm packages and submitting to registries or marketplaces are separate, explicitly approved actions; nothing in this checklist implies either has happened.

## Validation

Run `npm ci`, `npm test`, `npm run typecheck`, `npm run demo`, and `npm run pack:check`. The CI matrix runs Node 20, 22, and 24. Unit/integration tests exercise both MCP transports, REST, hash chaining, privacy, forged evidence, duplicate claims, connector failures, and historical rechecks.

Run `npm run doctor` with local GitHub configuration to verify MCP startup and all fifteen tools. It checks credential presence, not token permissions. `npm run doctor -- --json` is the machine-readable form; `npm run bug-report` produces the redacted support bundle used for issues. `npm run docs:errors` must leave `docs/ERRORS.md` unchanged (a core test enforces it), and `npm run evaluate:connectors` regenerates the public connector evaluations deliberately; ordinary test runs never touch them, and each connector's tests fail if its committed evaluation does not match the current package version.

Run the explicitly gated real [GitHub example](../examples/github-issues/README.md) in a test repository. Preserve its local proof JSON for inspection. Its audit and credential values must not be committed or uploaded. The v0.2 implementation was exercised against the real GitHub API on 2026-09-25: lost-response recovery, duplicate refusal, independent receipt, matching recheck, edited-object mismatch, original history retention, and fixture closure passed. A recovered interrupted run and a fresh end-to-end run both succeeded.

## Publication order

`.github/workflows/publish.yml` publishes on a `v*` tag from GitHub Actions with provenance. It checks that the tag equals every public package version, runs the validation above, and publishes in dependency order, skipping versions already on the registry so a failed run can resume. It runs in the `npm-publish` environment; give that environment required reviewers before any tag is pushed. Publishing with provenance requires GitHub Actions (or another supported CI); a publish from a workstation cannot attach provenance. The dependency order, if publishing by hand without provenance:

```sh
npm publish -w @77systems/receipts-core --access public
npm publish -w @77systems/receipts-sdk --access public
npm publish -w @77systems/receipts-proof --access public
npm publish -w @77systems/receipts-otel --access public
npm publish -w @77systems/receipts-conformance --access public
npm publish -w @77systems/receipts-github --access public
npm publish -w @77systems/receipts-file --access public
npm publish -w @77systems/receipts-gmail --access public
npm publish -w @77systems/receipts-mcp --access public
npm publish -w @77systems/receipts-rest --access public
npm publish -w @77systems/receipts-claude-plugin --access public
```

From a clean directory, verify the published MCP package starts and lists fifteen tools. The explicit setup-check invocation is:

```sh
npx -y --package=@77systems/receipts-mcp@0.4.0 receipts doctor
```

Source tests and pack dry-runs are not evidence of npm publication. Do not tag a release to trigger an external publishing workflow until publication has been authorized and configured. Registry and marketplace submissions are outside this milestone.

## Upgrade notes

Existing logs remain readable and show cooperative provenance. New writes require a caller UUID actionId, exact destinationAccount, and approvalId. Preserve IDs across uncertain retries. Existing `record`/`bind` integrations remain supported after adding these identities; they do not acquire independent provenance automatically.

The first historical receipt remains unchanged after later observations. Applications should use the explicit recheck response to evaluate current state. Evidence source and completion are distinct: a trusted read can independently confirm that content no longer matches.


## v0.3 acceptance

Core tests include separate-process JSONL contention for claims and rate limits, stale-owner fencing, expired unused reservations, dispatched uncertainty that cannot expire into another write, protected lifecycle state, policy rules, and legacy history. SDK tests prove denied callbacks never execute and successful read-back completes registry state after restart.

Signed-proof tests cover receipt/chain/head/key/time/signature tampering, offline verification, independent-only badges, unsafe link rejection and private-key exclusion. OTel tests inspect real in-memory exported spans and assert no payload/identity/error leakage or business-outcome changes when instrumentation fails.

The checked-in GitHub evaluation is generated from the actual connector with controlled provider responses. Publish that complete versioned evaluation before making a Receipts Certified claim. For a stable reference, use a commit-pinned artifact URL. Publishing the source branch/PR makes the evaluation publicly inspectable; npm availability and certification by an independent authority are separate claims.

No version tag or npm publication is performed automatically by this implementation. Badge/signature exports and telemetry exporters are opt-in. The original OS, execution sandboxing, payment rails, predictive recovery, hosted services and new destination surfaces remain outside the change.
