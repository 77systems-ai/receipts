# @77systems/receipts-github

Local, read-only GitHub issues connector for Receipts. Requires Node20+ and a local `GITHUB_TOKEN` or `GH_TOKEN`; an explicit token option is also supported. Credentials are used only for authentication to `https://api.github.com`, with redirect following disabled. The connector does not create or modify issues.

```ts
import {createGitHubIssuesConnector, githubAccount, githubIssuePayload} from '@77systems/receipts-github';
import {observeDestination} from '@77systems/receipts-core';
import {digestPayload} from '@77systems/receipts-sdk';
import {randomUUID} from 'node:crypto';

const payload=githubIssuePayload('Approved title','Approved body');
const receipt=await observeDestination(createGitHubIssuesConnector({owner:'owner',repo:'repo'}),{
  surface:'github-issue',attemptId:randomUUID(),actionId:randomUUID(),approvalId:randomUUID(),
  destinationAccount:githubAccount('owner','repo'),packageDigest:digestPayload(payload),
  locator:{issueNumber:42}, // A real discovered issue number.
});
```

For guarded writes, use the SDK with the connector configured and reconcile the original attempt instead of generating new action identities. See the root README.

The connector uses GitHub's [get an issue endpoint](https://docs.github.com/en/rest/issues/issues#get-an-issue). It checks repository URL, issue URL, number, and immutable numeric ID; rejects pull requests; and returns `github:issue:owner/repo:number:id`. Existing IDs can be passed as `destinationId` instead of a locator. Wrong accounts/objects, timeouts, redirects, and malformed responses fail closed.

`githubIssuePayload(title,body)` defines the exact approved content contract. A null body becomes an empty string. Labels, state, assignees, and comments are not verified by this contract. Title/body are processed locally in memory and hashed, never stored in the audit. Read permission is sufficient for this connector; the live example needs issue write permission for its synthetic fixture.

Timeout defaults to10 seconds and is configurable up to60 seconds. The connector performs one read per call and never retries outward writes. Caller evidence labels cannot invoke this connector or mint its provenance.

Tests run the public Receipts conformance suite plus GitHub-specific identity, timeout, input-validation, and credential-origin cases. The [live example](../../examples/github-issues/README.md) proves real API behavior.
