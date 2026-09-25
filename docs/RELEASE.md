# v0.3 release checklist

Source repository: https://github.com/77systems-ai/receipts

This milestone builds on merged v0.2 with atomic fenced claims, policy/rate admission, offline signed proofs/badges, scored conformance receipts and optional OTel. Publishing npm packages and submitting registries are separate actions. v0.3 does not alter an existing publishing workflow or claim a marketplace listing.

## Validation

Run `npm ci`, `npm test`, `npm run typecheck`, `npm run demo`, and `npm run pack:check`. The CI matrix runs Node 20, 22, and 24. Unit/integration tests exercise both MCP transports, REST, hash chaining, privacy, forged evidence, duplicate claims, connector failures, and historical rechecks.

Run `npm run doctor` with local GitHub configuration to verify MCP startup and all fourteen tools. It checks credential presence, not token permissions. `npm run doctor -- --json` is the machine-readable form; `npm run bug-report` produces the redacted support bundle used for issues. `npm run docs:errors` must leave `docs/ERRORS.md` unchanged (a core test enforces it), and `npm run evaluate:github` regenerates the public evaluation deliberately; ordinary test runs never touch it.

Run the explicitly gated real [GitHub example](../examples/github-issues/README.md) in a test repository. Preserve its local proof JSON for inspection. Its audit and credential values must not be committed or uploaded. The v0.2 implementation was exercised against the real GitHub API on 2026-09-25: lost-response recovery, duplicate refusal, independent receipt, matching recheck, edited-object mismatch, original history retention, and fixture closure passed. A recovered interrupted run and a fresh end-to-end run both succeeded.

## Publication order

After review, authenticate an npm account authorized for the `@77systems` scope or use a separately configured trusted-publishing workflow. Publish in dependency order:

```sh
npm publish -w @77systems/receipts-core --access public
npm publish -w @77systems/receipts-sdk --access public
npm publish -w @77systems/receipts-github --access public
npm publish -w @77systems/receipts-conformance --access public
npm publish -w @77systems/receipts-proof --access public
npm publish -w @77systems/receipts-otel --access public
npm publish -w @77systems/receipts-mcp --access public
npm publish -w @77systems/receipts-rest --access public
npm publish -w @77systems/receipts-claude-plugin --access public
```

From a clean directory, verify the published MCP package starts and lists fourteen tools. The explicit setup-check invocation is:

```sh
npx -y --package=@77systems/receipts-mcp@0.3.0 receipts doctor
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
