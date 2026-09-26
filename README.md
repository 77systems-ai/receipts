# Receipts

**Verification for every AI agent.**

An agent says DONE. Receipts asks for an observed destination object bound to the exact approved package. When delivery is uncertain, its executor wrapper refuses another write and supports reading back the existing object.

v0.3 adds atomic expiring reservations, write policies and rate limits, opt-in Ed25519 signed proofs and offline badges, scored conformance evaluations, and OpenTelemetry integration. v0.2's independent GitHub verification and permanent cooperative evidence path remain intact. This is the source release; npm publication is a separate release step.

## Run from source

Node.js 20 or later. The offline demo needs no credentials.

```sh
git clone https://github.com/77systems-ai/receipts.git
cd receipts
npm ci
npm test
npm run demo
```

The offline Grok reference demo simulates a lost response and recovery. Its evidence is explicitly **host-supplied**, not independently verified.

New here? [Get your first verified receipt in 5 minutes](docs/QUICKSTART.md) — no tokens, no accounts, just the file connector on your own disk.

## Two evidence paths

| Evidence path | Source | Independently verified |
| --- | --- | --- |
| Caller records an observation, including a claimed `provider` source | `host-supplied` | `false` |
| A locally configured Receipts connector actually reads the destination | `receipts-read` | `true` |

The cooperative path remains supported for chat integrations and human observations. Caller-supplied trust flags cannot upgrade it. Both paths can bind observations to approved package digests; applications can additionally require independent verification.

`complete` describes a matching observed object and package binding. It is not a claim that the destination can never change. Every receipt carries the exact account, object ID, action ID, package digest, proof source, independence flag, and original observation time.

## Write admission: claims and policies

The SDK reserves an approved action, checks policy, and atomically records dispatch before invoking the provider. Concurrent callers share the durable registry: one wins; the other gets an audited `DUPLICATE` decision. `DuplicateWriteError` remains compatible and now carries that decision.

Unused reservations expire after a configurable TTL and can be released. Once dispatch has been recorded, neither expiry nor release permits another write: an uncertain outcome must be reconciled. Completion requires an existing exact destination binding. Stale lease owners are fenced off after reclaim.

```ts
const receipts = createReceipts({
  store,
  connector,
  claimTtlMs: 60_000,
  policy: {
    rules: [{id:'blocked-repository',effect:'block',destinationAccount:'github:owner/restricted'}],
    rateLimits: [{id:'issues-per-hour',surface:'github-issue',maxWrites:10,windowMs:3_600_000}],
  },
});
```

The default policy permits registered surfaces. Explicit block rules win; an optional `defaultEffect: 'block'` enables allow-list behavior. A blocked write throws `PolicyDeniedError` with `verdict: 'policy_denied'`, its `ruleId`, and an audit reference. Policy is evaluated at claim and again at dispatch: a forbidden write is refused at claim with a single audited `policy_denied` record and no reservation, while a budget consumed between claim and dispatch is denied at dispatch and the unused reservation is released. No provider write happens either way. Budgets count durable dispatch attempts, including uncertain ones, across clients sharing the store. An approval is spent by any other action on its account that may have written or holds a live reservation; released or expired unused reservations free it.

Admission outcomes explain whether execution may start. They are separate from the four destination-verification verdicts below. Direct registry APIs and detailed lease rules are in [core](packages/core/README.md). All writers must use the guarded boundary; this is not an execution sandbox.

## Offline signed proofs and measured conformance

The opt-in [proof package](packages/proof/README.md) signs the exact receipt hash and audit snapshot head using a local Ed25519 key. An offline verifier checks both the signature and chain against a separately trusted public key. It can render **Verified by Receipts · independently verified · receipt #abc123** for valid, independently complete receipts. No tracking or verification service is involved. Exported snapshots include audit metadata, so review them before publishing.

Every [conformance v2](packages/conformance/README.md) run emits a benchmark/version, connector version, seeded environment provenance, per-case outcomes, and counted error rates. The public 0.4.0 evaluations for the [GitHub](docs/evaluations/github-0.4.0.json), [file](docs/evaluations/file-0.4.0.json), and [Gmail](docs/evaluations/gmail-0.4.0.json) connectors each contain seven passing cases: 0/6 false completions, 0/4 false blocks, and 0/3 unsafe dispatches. These are fixed-fixture measurements, not production reliability estimates. A “Receipts Certified” claim requires a published matching evaluation; the library evaluates eligibility without pretending to verify a remote publication.

The optional [OpenTelemetry package](packages/otel/README.md) emits verification/receipt spans with verdict, evidence source and digests. It exports no payloads, identities, credentials or error text, and installs no network exporter.

## First independent integration: GitHub issues

Configure a token locally and an exact repository:

```sh
export RECEIPTS_GITHUB_REPO=your-owner/your-repository
# Supply GITHUB_TOKEN or GH_TOKEN through your local environment.
npm run doctor
```

The setup check starts the actual MCP server, checks all fifteen tools, and checks credential presence without printing values or calling GitHub. It does not test token permissions. `npm run doctor -- --json` prints the same checks as JSON, and `npm run bug-report` assembles a redacted support bundle (versions, platform, configuration presence, doctor checks, audit shape) as a prefilled GitHub issue that you review before submitting; it never captures payloads, credentials, identifiers, or file paths.

The connector performs only `GET /repos/{owner}/{repo}/issues/{number}`. It validates the exact repository and immutable GitHub object ID, rejects pull requests, and hashes the observed title and body. The approved package shape is `githubIssuePayload(title, body)`; `null` bodies normalize to an empty string. Labels, comments, assignees, and issue state are outside this package identity.

Run the real acceptance example against a **test repository** with Issues enabled and a token permitted to create/read/edit issues there:

```sh
export RECEIPTS_TEST_REPO=your-owner/your-test-repository
npm run demo:github -- --live
```

This deliberately creates one synthetic issue, discards its successful response, blocks a duplicate, finds it through reads, issues an independent receipt, rechecks it, edits it, records the mismatch, and closes it. No write occurs without `--live`. It exports a proof JSON and hash-chained audit under `.receipts/`. See [the example](examples/github-issues/README.md) for interrupted-run recovery.

## TypeScript executor

```ts
import { randomUUID } from 'node:crypto';
import { createReceipts } from '@77systems/receipts-sdk';
import {
  createGitHubIssuesConnector, githubAccount, githubIssuePayload,
} from '@77systems/receipts-github';

const owner = 'your-owner';
const repo = 'your-repository';
const receipts = createReceipts({
  connector: createGitHubIssuesConnector({ owner, repo }),
});
const attemptId = randomUUID();
const actionId = randomUUID(); // Persist once per approved logical action.
const approvalId = randomUUID(); // Supplied by your host's approval flow.
const payload = githubIssuePayload('Approved title', 'Approved body');

await receipts.execute({
  surface: 'github-issue', attemptId, actionId, approvalId,
  destinationAccount: githubAccount(owner, repo), payload,
  execute: async ({ payload }) => {
    // Your existing provider call goes here. Never retry it on an uncertain result.
    // A successful response is still not independent destination proof.
  },
});

// Supply an actual discovered issue number; never invent one.
const result = await receipts.reconcile({
  surface: 'github-issue', attemptId, payload, locator: { issueNumber: 42 },
});
receipts.claimComplete(result, { requireIndependent: true });
```

All writers must use the wrapper, share a durable audit store, and retain the original action/account identity. Reusing `(destinationAccount, actionId)` is blocked; changing content or attempt IDs does not evade that guard. Identical content with a new action and new approval is allowed. An approval identifier records host authorization; Receipts does not authenticate an approval UI or sandbox arbitrary application code.

`recheck(...)` appends the current observation. `getReceipt(...)` returns the original stored receipt without querying the provider or refreshing its time. Compare both the verdict and `independentlyVerified`; an independently observed **mismatch** is still a mismatch.

## MCP and REST

Run stdio MCP from source:

```sh
node packages/mcp-server/dist/cli.js
```

Use an absolute path in your MCP client's configuration. Set `RECEIPTS_AUDIT_PATH` to a persistent local path shared by cooperating processes. Set `RECEIPTS_GITHUB_REPO` and a local token to enable independent GitHub reads. Set `RECEIPTS_FILE_ROOTS` for file-write read-back, or `RECEIPTS_GMAIL_ACCOUNT` and `RECEIPTS_GMAIL_TOKEN` for Gmail send read-back; see the [MCP README](packages/mcp-server/README.md#configuration).

Fifteen tools. Evidence: `receipts.classify`, `receipts.record`, `receipts.bind`, `receipts.verify`, `receipts.observe`, and `receipts.recheck`. Admission: `receipts.prepare` (digest, policy, and claim in one call, including claims from a staged file), `receipts.digest`, `receipts.policy`, `receipts.claim`, `receipts.dispatch`, `receipts.release`, and `receipts.complete`. Proof: `receipts.sign` and `receipts.badge`. Caller evidence always uses the cooperative path; observe and recheck use connectors configured locally at startup.

An agent prepares the write (digest, policy, and claim in one call, from the approved payload or a staged file), dispatches immediately before its one outward write, then observes the destination; a matching independent read completes the lease, and the cooperative path completes it with `receipts.complete` after record and bind. Policy (`--policy FILE`), claim TTL (`--claim-ttl MS`), and the signing key (`--signing-key FILE`, PEM Ed25519) are host-owned startup configuration: no tool call can change them, and sign/badge refuse until a local key is configured. The MCP surface cannot force an agent to dispatch before writing; the SDK wrapper enforces that order in code. Node integrators driving the server can use `@77systems/receipts-mcp/client`, whose every call has a deadline (60 seconds by default) and fails loudly instead of hanging.

```sh
node packages/mcp-server/dist/cli.js --transport http --port 3100
node packages/rest/dist/cli.js --port 3101
```

Streamable HTTP listens on `http://127.0.0.1:3100/mcp`; REST uses `http://127.0.0.1:3101`. Both are loopback-only. REST exposes `POST /classify`, `/record`, `/bind`, `/observe`, `/recheck`, and `GET /verify`. Hosted chat connectors need a separately secured gateway; none is included here.

The [Claude plugin](packages/claude-plugin/README.md) combines MCP, automatic tool-result feedback, and a verification skill. Hooks report evidence; the SDK controls writes routed through its executor.

## Four verdicts

| Verdict | What it means | Permitted next step |
| --- | --- | --- |
| `complete` | Observed destination ID is bound to the approved package | Inspect provenance and observation time; recheck when needed |
| `delivery_unknown` | A write may have happened | Read the destination; never automatically retry or create a second object |
| `package_unverified` | An object exists without a matching approved binding | Inspect/bind the existing object; never create another |
| `prewrite` | No destination evidence, or confirmed never reached | Rearm only with affirmative prewrite evidence, fixed cause, a new digest and attempt |

Precedence stays `complete → delivery_unknown → package_unverified → prewrite`. All verdicts deny automatic retry and second writes. Unknown surfaces throw `not_a_destination_write`. Status flags never prove completion. `classify` is pure; a hypothetical classification is not a stored receipt.

## Privacy and trust

**Local reads. Hashes in your audit.** The connector processes destination content in local memory to compute a digest; it never stores issue titles, bodies, credentials, or arbitrary provider errors in the audit. Evidence descriptions and external references are digested. Use opaque identifiers for account, approval, attempt, and provider idempotency metadata; never put payload text or secrets in identifier fields.

The audit stays on your disk. There is no Receipts-hosted service or telemetry. Credentials come from your local environment and are sent only to GitHub for authentication over HTTPS, with redirects disabled. We do not receive them. “Receipts never sees data” would be inaccurate: read-back needs to inspect the destination locally.

Every error, refusal, and decision reason Receipts surfaces maps to one documented code in [the error taxonomy](docs/ERRORS.md), generated from core and enforced by a test; MCP and REST error envelopes carry its hint and link.

Every persisted entry is hash chained. A retained head checkpoint detects local edits or truncation; someone able to rewrite both the log and head can forge history. This is not a provider signature or an externally witnessed proof. Locally configured executable connectors and storage implementations remain trusted boundaries. No blockchain or anchoring is included.

## Packages and compatibility

- `receipts-core`: dependency-free classification, registry, audit, bindings and connector contract.
- `receipts-sdk`: canonical payload hashing and durable executor guard.
- `receipts-github`: independent GitHub issues reader.
- `receipts-file`: independent local file-write reader.
- `receipts-gmail`: independent Gmail send reader (operator-supplied mail client).
- `receipts-conformance`: scored failure-case suite and versioned evaluation receipts.
- `receipts-proof`: local signatures, offline chain verification and static badges.
- `receipts-otel`: explicit OpenTelemetry instrumentation with digest-only attributes.
- `receipts-mcp`, `receipts-rest`, `receipts-claude-plugin`: integration surfaces.

All packages use the `@77systems/` npm scope. v0.1 logs remain readable with cooperative provenance, and v0.2 claims remain reconcilable without inventing leases. New durable actions require `actionId` (UUID), `destinationAccount`, and `approvalId`; existing integrations must add those identities before writing v0.2 entries. Legacy generic surface registrations remain available; GitHub issues, file-write, and email-send are the bundled example integrations.

The entire local mechanism is MIT licensed. No signup, hosted infrastructure, UI, billing, or marketplace submission is included.

[Architecture](docs/ARCHITECTURE.md) · [Conformance](packages/conformance/README.md) · [Release checklist](docs/RELEASE.md) · [MIT license](LICENSE)
