# Live GitHub lost-response recovery

Build from the repository root with `npm ci && npm run build`. Choose a test repository with Issues enabled. Set `RECEIPTS_TEST_REPO=owner/repo` and supply a local `GITHUB_TOKEN` or `GH_TOKEN` authorized to create, read, edit and close issues there.

```sh
npm run demo:github -- --live
```

Without `--live`, this prints help and makes no requests.

The example creates exactly one synthetic issue for a new UUID action/approval. It intentionally discards the successful POST response, records delivery_unknown, and proves a second execution is blocked. Read-only discovery finds the unique fixture; bounded read retries accommodate listing delays. The trusted connector then reads the issue directly and compares its content hash. Matching and edited rechecks append separate observations while the original receipt and audit prefix remain unchanged. The fixture is closed after the checks.

Output includes all receipt fields, the issue URL, local audit path, and local proof JSON path. The proof file is readable by anyone the owner chooses to share it with; access to a private test issue still requires repository access. Neither file is uploaded by Receipts. The issue text, token, and provider error content must be absent from the audit.

## Recover an interrupted discovery/read

An unsuccessful run can already have created the issue. Do not start another write. Inspect the existing audit and test repository. To continue the same action before the fixture has been edited:

```sh
RECEIPTS_AUDIT_PATH=/absolute/path/to/original/audit.jsonl \
  npm run demo:github -- --live --resume
```

Resume uses the original account/action/approval/attempt from the saved claim, checks its payload digest, makes zero create requests, and repeats the duplicate-guard check. It refuses ambiguous/missing discovery. A run interrupted after editing may need manual inspection because the original package should no longer match. Completed proof files are never overwritten.

For setup diagnostics, configure `RECEIPTS_GITHUB_REPO=owner/repo` separately and run `npm run doctor`. The example's write target is deliberately explicit as `RECEIPTS_TEST_REPO`.
