# Receipts MCP

**Verification for every AI agent.** Four tools expose the Receipts core over stdio or Streamable HTTP. Node.js 20+; MIT.

## Run

From this repository, after `npm ci && npm run build`:

```sh
node packages/mcp-server/dist/cli.js
node packages/mcp-server/dist/cli.js --transport http --port 3100
```

The release is configured for the following command after npm publication:

```sh
npx -y @77systems/receipts-mcp
```

A stdio client configuration after publication:

```json
{
  "mcpServers": {
    "receipts": {
      "command": "npx",
      "args": ["-y", "@77systems/receipts-mcp"],
      "env": { "RECEIPTS_AUDIT_PATH": "/absolute/path/receipts/audit.jsonl" }
    }
  }
}
```

Before publication, replace the command with `node` and the arguments with the absolute path to `packages/mcp-server/dist/cli.js` in your checkout.

| Flag | Default | Effect |
| --- | --- | --- |
| `--transport stdio\|http` | `stdio` | Choose the MCP transport. |
| `--port NUMBER` | `3100` | HTTP port, 1–65535. |
| `--audit-path FILE` | Core default | Override `RECEIPTS_AUDIT_PATH`. |
| `--help` | | Print usage and exit. |

The default audit file is `.receipts/audit.jsonl`, relative to the process working directory. Use an absolute `RECEIPTS_AUDIT_PATH` to share the same audit between clients. The core also maintains `.head` and transient `.lock` sidecars; keep these with the log.

Streamable HTTP listens at `http://127.0.0.1:3100/mcp`. It uses stateless requests and JSON responses; audit records persist in the store. GET/SSE sessions are not used. v1 has no authentication and deliberately has no remote bind flag. A remote deployment needs a separately operated authenticated gateway and a trusted evidence producer. Host and Origin checks protect the local endpoint from browser-origin misuse; they do not authenticate local clients.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `receipts.classify` | `{ "write": OutwardWrite }` | Verdict, retry law, and permission booleans. |
| `receipts.record` | `{ "entry": AuditEntry }` | `{ "recorded": true, "id": "…" }` |
| `receipts.bind` | `{ "destinationId": "…", "packageDigest": "sha256:…" }` | Binding and its audit identifiers. |
| `receipts.verify` | Same identity fields as bind. | `{ "verdict": "…" }` |

For example, call `receipts.classify` with:

```json
{
  "write": {
    "surface": "social-publish",
    "attemptId": "attempt-1",
    "packageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "writeMayHaveHappened": true
  }
}
```

This deliberately fictional digest is for demonstration. The result is `delivery_unknown`, with `mayAutoRetry`, `maySecondWrite`, and `mayRearm` all false. In a real integration, compute the digest from the exact approved payload with the SDK.

The tools evaluate supplied evidence. They do not contact providers, publish content, or establish whether a client assertion is true. `classify` is a pure evaluation and does not create a durable receipt. `bind` requires a prior audit observation containing a provider/human ID and matching package digest; use `verify` afterward to check the durable audit. Only trusted adapters or a real operator should submit observation evidence. An ID or observation invented by the model remains invalid evidence even if its text fits a schema.

Failures from core return `isError: true` with `{ "error": { "code": "…", "message": "…" } }` as text and structured content. Invalid tool argument shapes produce an MCP input-validation error. Unknown surfaces return `not_a_destination_write`; there is no fifth verdict. HTTP rejects invalid content types, bodies over 1 MiB, invalid JSON, foreign Host headers, and cross-origin requests. Startup failures write a JSON error to stderr and exit nonzero. Stdout is reserved for MCP in stdio mode.

## Extend and test

Custom surfaces are registered in process with core `registerSurface` before calling the exported `createReceiptsServer` or `startHttpServer`. A surface's `observe` callback is invoked by your integration, never by these tools. Supply a custom synchronous `AuditStore` through the factory's `{ store }` option.

```sh
npm run build
npm test --workspace @77systems/receipts-mcp
```

Tests use official MCP clients against both a real stdio subprocess and a local HTTP listener, including an uncertain write resolved by observation and binding. Transport implementation follows the [official TypeScript SDK server guide](https://ts.sdk.modelcontextprotocol.io/server).
