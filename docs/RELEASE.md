# v0.1 release status

Source repository: https://github.com/77systems-ai/receipts

This repository contains v1 implementation and release metadata. Creating a repository is separate from publishing packages and obtaining registry approval.

## Publication order

Run `npm ci`, `npm test`, `npm run typecheck`, `npm run demo`, and inspect `npm pack --dry-run --workspaces`. Authenticate an npm account authorized to publish the `@77systems` scope. Then publish in dependency order:

```sh
npm publish -w @77systems/receipts-core --access public
npm publish -w @77systems/receipts-sdk --access public
npm publish -w @77systems/receipts-mcp --access public
npm publish -w @77systems/receipts-rest --access public
npm publish -w @77systems/receipts-claude-plugin --access public
```

Verify from a clean directory that `npx -y @77systems/receipts-mcp@0.1.0` initializes and lists the four tools. Repeat with Streamable HTTP and the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector). Source integration tests exercise the protocol before publication; they are not evidence of an npm release.

## Registry and marketplace

`server.json` uses the [official MCP Registry schema](https://modelcontextprotocol.io/registry/quickstart). Its name must match the MCP package's `mcpName`. After npm publication, authenticate with `mcp-publisher login github`, validate, and publish. `smithery.yaml` describes the pinned local stdio launch. No hosted endpoint is claimed.

The Claude plugin source and repository marketplace manifest are included. Submit the reviewed bundle through the relevant vendor portal after its npm dependencies exist. Smithery, Glama, mcp.so, awesome-mcp-servers, the Official MCP Registry, and Claude Marketplace are launch follow-ups; no listing or approval is claimed.

## Outstanding release inputs

- npm authentication and publish rights for `@77systems` are not available in the initial build environment.
- No existing Grok bot template was supplied or found in the workspace/org repository listing. The included example is an offline reference implementation, not a claimed rewrite of an unavailable template.
- Patent filing evidence and application number were not supplied. Add the requested patent-pending line only after filing is confirmed and replace the number with the real application number. The source README makes no unverified filing claim.

## Release claims

The SDK enforces writes routed through it; it does not sandbox arbitrary code. Hooks provide automatic feedback for configured tools and cannot prevent every external write or force an agent's language. Generic surfaces are examples, not provider-certified adapters. Remote hosting, authentication, billing, user accounts, and UI are out of scope.
