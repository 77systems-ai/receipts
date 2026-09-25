# Receipts for Claude Code

Verification for every AI agent. This bundle provides MCP tools, PostToolUse/PostToolUseFailure feedback, and the cooperative Receipts skill.

After npm publication:

```text
/plugin marketplace add 77systems-ai/receipts
/plugin install receipts@77systems
```

For source development, build the repository first, then use `claude --plugin-dir ./packages/claude-plugin`. Its hook launcher uses the local build if present; marketplace installs use the pinned published hook package. The MCP config uses the published MCP package; before publication, use the source MCP command from the root README.

The hooks run automatically. Standard Write/Edit/NotebookEdit tools map to file-write; other write tools must be mapped explicitly, for example:

```sh
export RECEIPTS_HOOK_TOOLS='{"mcp__social__publish":"social-publish","mcp__mail__send":"email-send"}'
```

A mapped tool can return a `receipts` object (directly or inside `structuredContent`) with `destinationId` and `packageDigest`. These are lookup pointers, not proof. The hook checks the existing audit binding against the mapped surface, current host tool_use_id as attempt ID, destination ID, and package digest before allowing a complete verdict. Adapters that want automatic complete feedback must use that host tool-call ID as their audited attempt ID; a missing ID stays unverified. It never trusts a tool's `complete` or `boundPackageDigest` claim. Missing or failed outcomes remain uncertain. Unmapped outward tools request an adapter and cannot be verified by this hook.

Hooks run after tools; they cannot undo the action, intercept every arbitrary shell write, or force an LLM's final words. Use the SDK executor wrapper for enforcement in the write path. The skill is cooperative in chat environments. This repository is not an approved Claude Marketplace listing.

Configuration follows the official [hooks reference](https://code.claude.com/docs/en/hooks) and [plugin manifest reference](https://code.claude.com/docs/en/plugins-reference).
