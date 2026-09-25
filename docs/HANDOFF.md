# Initial implementation — 2026-09-25

The v1 source implementation is complete as a standalone TypeScript/Node npm workspace. The public package boundary contains core, MCP, SDK, REST, and Claude plugin packages plus the offline Grok reference demo. UI, accounts, auth, billing, and hosted infrastructure are excluded.

## Verification

- 46 tests pass: 22 core invariants/audit tests, 11 SDK tests, 6 transport tests, and 7 Claude hook tests.
- All six workspaces build and typecheck.
- The Grok demo produces exactly one simulated destination write, refuses a completion claim and duplicate dispatch while uncertain, then observes and binds the existing object.
- Real MCP clients exercise stdio and Streamable HTTP, including all four tools and the complete reconciliation path.
- MCP Inspector initializes the source executable and lists receipts.classify, receipts.record, receipts.bind, and receipts.verify.
- The REST server is exercised through real loopback HTTP.
- Root server.json validates against the declared official MCP Registry schema.
- All five publishable package previews include compiled entry points, README, and MIT license.
- All five tarballs install together in a fresh project. On Node 20.20.2, their CLI binaries, both MCP transports, REST, hook input/output, SDK completion, and duplicate refusal pass smoke checks.

Two independent review findings were corrected and covered by regression tests: one object/digest cannot credit separate attempts, and an explicitly mapped outward tool containing “receipts” in its name is not excluded from hook feedback. Additional tests ensure hook completion matches the current tool-call attempt and surface.

## Release boundary

Source checks and local MCP tests are not proof of npm publication. npm authentication, registry submissions, marketplace approval, an existing Grok template, and patent filing details remain external release inputs documented in RELEASE.md.

Evidence authenticity belongs to configured read-back adapters or explicit human attestations. No live provider credentials or real customer receipts are included. The examples are fixtures. The SDK enforces calls routed through its wrapper; the hook is automatic feedback, not an execution sandbox. Hash chaining and a local retained head checkpoint detect local inconsistencies but do not defeat an attacker replacing both files.
