# Receipts

**Verification for every AI agent.**

An agent says DONE. Receipts asks for an observed destination object bound to the exact approved package. When delivery is uncertain, its executor wrapper refuses another write and supports reading back the existing object.

v0.2 adds independent GitHub issue verification, action-scoped duplicate protection, immutable observation history, `receipts doctor`, and a public connector conformance suite. This repository contains the source release; npm publication is a separate release step.

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

## Two evidence paths

| Evidence path | Source | Independently verified |
| --- | --- | --- |
| Caller records an observation, including a claimed `provider` source | `host-supplied` | `false` |
| A locally configured Receipts connector actually reads the destination | `receipts-read` | `true` |

The cooperative path remains supported for chat integrations and human observations. Caller-supplied trust flags cannot upgrade it. Both paths can bind observations to approved package digests; applications can additionally require independent verification.

`complete` describes a matching observed object and package binding. It is not a claim that the destination can never change. Every receipt carries the exact account, object ID, action ID, package digest, proof source, independence flag, and original observation time.

## First independent integration: GitHub issues

Configure a token locally and an exact repository:

```sh
export RECEIPTS_GITHUB_REPO=your-owner/your-repository
# Supply GITHUB_TOKEN or GH_TOKEN through your local environment.
npm run doctor
```

The setup check starts the actual MCP server, checks all six tools, and checks credential presence without printing values or calling GitHub. It does not test token permissions.

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

Use an absolute path in your MCP client's configuration. Set `RECEIPTS_AUDIT_PATH` to a persistent local path shared by cooperating processes. Set `RECEIPTS_GITHUB_REPO` and a local token to enable independent GitHub reads.

Six tools: `receipts.classify`, `receipts.record`, `receipts.bind`, `receipts.verify`, `receipts.observe`, and `receipts.recheck`. Caller evidence always uses the cooperative path. The last two tools use connectors configured locally at startup.

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

Every persisted entry is hash chained. A retained head checkpoint detects local edits or truncation; someone able to rewrite both the log and head can forge history. This is not a provider signature or an externally witnessed proof. Locally configured executable connectors and storage implementations remain trusted boundaries. No blockchain or anchoring is included.

## Packages and compatibility

- `receipts-core`: dependency-free classification, registry, audit, bindings and connector contract.
- `receipts-sdk`: canonical payload hashing and durable executor guard.
- `receipts-github`: independent GitHub issues reader.
- `receipts-conformance`: reusable failure-case suite for connectors.
- `receipts-mcp`, `receipts-rest`, `receipts-claude-plugin`: integration surfaces.

All packages use the `@77systems/` npm scope. v0.1 logs remain readable with cooperative provenance. New durable actions require `actionId` (UUID), `destinationAccount`, and `approvalId`; existing integrations must add those identities before writing v0.2 entries. Legacy generic surface registrations remain available; GitHub issues is the only added provider integration.

The entire local mechanism is MIT licensed. No signup, hosted infrastructure, UI, billing, or marketplace submission is included.

[Architecture](docs/ARCHITECTURE.md) · [Conformance](packages/conformance/README.md) · [Release checklist](docs/RELEASE.md) · [MIT license](LICENSE)
