# Receipts for Claude Code

This bundle provides the fifteen Receipts MCP tools, PostToolUse/PostToolUseFailure feedback, and the cooperative Receipts skill. The skill walks a chat client through the guarded sequence: `receipts.prepare` (digest, policy, and claim in one call, from the approved payload or a staged file), `receipts.dispatch`, exactly one outward write, then `receipts.observe` (or `receipts.record`, `receipts.bind`, and `receipts.complete`). `DUPLICATE` names its reason (`completed`/`dispatched`: reconcile under the original attemptId, never write again; `active_claim`: another live reservation, nothing written, wait; `approval_reused`: request a separate approval per write); `policy_denied` means release, stop, and report the rule. The hook ignores every Receipts tool, so admission and proof calls never trigger outward-write feedback.

After npm publication:

```text
/plugin marketplace add 77systems-ai/receipts
/plugin install receipts@77systems
```

For source development, build the repository first, then use `claude --plugin-dir ./packages/claude-plugin`. Its hook launcher uses the local build if present; marketplace installs use the pinned published hook package. Before npm publication, configure MCP with the source command from the root README.

The hooks run automatically. Standard Write/Edit/NotebookEdit tools map to file-write; other write tools need exact mappings:

```sh
export RECEIPTS_HOOK_TOOLS='{"mcp__social__publish":"social-publish","mcp__mail__send":"email-send","mcp__github__create_issue":"github-issue"}'
```

A mapped tool can return a `receipts` object directly or inside `structuredContent`, containing `destinationId`, `packageDigest`, `destinationAccount`, `actionId`, and `approvalId`. These are lookup pointers. The hook requires an existing audit binding matching all of them, the configured surface, and the current host `tool_use_id` as `attemptId`. Adapters must audit that exact host tool-call ID. Missing identity, a different account/action/approval, or tool failure cannot borrow another receipt.

Feedback reports the stored `evidenceSource`, `independentlyVerified`, and original `observedAt`. Cooperative evidence stays `host-supplied` and false, even if the tool response claims provider or independent proof. Independently executed connector reads are reported as `receipts-read` and true. The hook never silently updates an old receipt's time; an explicit read-only recheck appends its own history. The reported original receipt is historical verification, not a fresh destination check.

The hook never persists tool claims or copies raw input into the audit. Unmapped outward tools request an adapter. Hooks run after execution and cannot undo actions or intercept every shell command. Use the SDK executor wrapper to enforce the write path. The skill provides cooperative guidance for chat clients. This repository is not an approved Claude Marketplace listing.

Configuration follows the official [hooks reference](https://code.claude.com/docs/en/hooks) and [plugin manifest reference](https://code.claude.com/docs/en/plugins-reference).
