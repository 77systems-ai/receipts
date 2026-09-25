# Receipts

**Verification for every AI agent.**

Agents say DONE. Receipts asks for the receipt: an observed destination object, bound to the exact approved package, preserved in an append-only audit. If the result is uncertain, Receipts says what can happen next—and refuses the retry that would create a duplicate.

One mechanism for Claude, ChatGPT integrations, Cursor, Grok, LangChain-style applications, and agents you build yourself. MCP, TypeScript SDK, and REST are thin wrappers around the same dependency-free core.

**v0.1 source is available. npm packages and marketplace/registry listings are not published yet.** Use the source quickstart now. The pinned npm commands below are the release installation paths and become available after publication.

## Run from source

Node.js 20 or later. No account, API key, signup, or hosted service is required.

```sh
git clone https://github.com/77systems-ai/receipts.git
cd receipts
npm ci
npm test
npm run demo
```

The offline Grok reference demo makes one simulated write, loses the response, refuses a second write and a completion claim, observes the existing destination, and binds its receipt. It sends nothing to a real service.

## The 30-second demo

After `npm test` has built the workspaces:

```sh
node --input-type=module <<'JS'
import { classify, digestPackage } from '@77systems/receipts-core';
const result = classify({
  surface: 'social-publish',
  attemptId: 'launch-001',
  packageDigest: digestPackage('The exact approved post'),
  writeMayHaveHappened: true,
});
console.log(result);
JS
```

```json
{
  "verdict": "delivery_unknown",
  "mayAutoRetry": false,
  "maySecondWrite": false,
  "mayRearm": false,
  "retryLaw": "never_auto_retry",
  "destinationId": null,
  "summary": "A write may have happened. Observe the destination; never retry or create a second write."
}
```

`classify` is pure. It does not read a provider or persist proof. For durable completion, record trusted read-back evidence, bind the object to its approved digest, and verify the audit. A model-supplied ID is not automatically trusted evidence.

## Four verdicts. Clear next steps.

| Verdict | What is known | Auto retry | Second write | Rearm |
| --- | --- | --- | --- | --- |
| `prewrite` | Destination has not been reached, or no destination evidence is supplied | No | No | Only with affirmative prewrite evidence, fixed cause, new digest **and** new attempt |
| `delivery_unknown` | A write may have happened | Never | Never | No |
| `package_unverified` | An object exists; the package binding is missing | Never | Never | No |
| `complete` | Destination ID and approved package binding match | No | No | No |

Precedence is `complete → delivery_unknown → package_unverified → prewrite`. Unknown surfaces throw `not_a_destination_write`; this is a rejection, not a fifth verdict. A status like `sent`, `published`, or `completed` never proves success.

## Connect your agent

### Claude Code, Cursor, and local MCP clients

Run the source server now:

```sh
node packages/mcp-server/dist/cli.js
```

Use an absolute path to that file in your client's MCP configuration with `command: "node"`. After npm publication, the portable configuration is:

```json
{
  "mcpServers": {
    "receipts": {
      "command": "npx",
      "args": ["-y", "@77systems/receipts-mcp@0.1.0"],
      "env": { "RECEIPTS_AUDIT_PATH": "/absolute/path/to/receipts-audit.jsonl" }
    }
  }
}
```

Four tools: `receipts.classify({write})`, `receipts.record({entry})`, `receipts.bind({destinationId, packageDigest})`, and `receipts.verify({destinationId, packageDigest})`.

Streamable HTTP is also available for clients that use it:

```sh
node packages/mcp-server/dist/cli.js --transport http --port 3100
```

The endpoint is `http://127.0.0.1:3100/mcp`. v1 binds to loopback; hosted ChatGPT/Claude connectors require a separately secured gateway. No hosted endpoint or authentication service is included.

### Claude plugin

The bundle combines MCP tools, automatic tool-result feedback, and a verification skill. After npm publication:

```text
/plugin marketplace add 77systems-ai/receipts
/plugin install receipts@77systems
```

The hook runs without asking the model to invoke it. Configure exact outward-tool mappings; it checks existing audit bindings and does not accept a tool's success claim as proof. Hooks provide feedback after execution. The SDK wrapper enforces the write path. See [plugin setup and coverage](packages/claude-plugin/README.md). Marketplace submission is pending.

### Grok, LangChain-style apps, and custom agents

After publication, install `@77systems/receipts-sdk` and `@77systems/receipts-core`. The same imports work inside this source workspace now.

```ts
import { createReceipts } from '@77systems/receipts-sdk';

const receipts = createReceipts();
const result = await receipts.execute({
  surface: 'social-publish',
  attemptId: 'launch-001',
  idempotencyKey: 'social:account-42:launch',
  payload: { account: 'account-42', text: 'The exact approved post' },
  execute: async ({ payload, idempotencyKey }) => {
    // Call your provider here, forwarding its idempotency key if supported.
    // A success response alone will not complete this receipt.
  },
});

// Throws until a trusted observer has produced an audited package binding.
receipts.claimComplete(result);
```

Register a surface with a read-only `observe` adapter for real completion. The SDK computes the payload digest, persists an atomic execution claim, and marks a thrown result uncertain without retrying. All callers must use the wrapper and share the store and stable action keys. [The runnable reference demo](examples/grok-bot) shows the full resolution path.

### REST / non-JavaScript stacks

```sh
node packages/rest/dist/cli.js --port 3101
```

```sh
curl http://127.0.0.1:3101/classify \
  -H 'Content-Type: application/json' \
  -d '{"surface":"http-post","attemptId":"request-1","packageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","writeMayHaveHappened":true}'
```

The digest in this classification-only example is illustrative. Production calls must hash the exact approved payload.

Routes: `POST /classify`, `POST /record`, `POST /bind`, `GET /verify?destinationId=...&packageDigest=...`. Configure one persistent audit path for cooperating processes. HTTP request handlers hold no session state; the audit backend retains receipts. See [REST details](packages/rest/README.md).

## The mechanism

- `packages/core`: pure classification, closed pluggable surface registry, digest validation, binding, verification, and hash-chained JSONL audit. Zero runtime dependencies.
- `packages/mcp-server`: stdio and Streamable HTTP.
- `packages/sdk`: payload hashing and enforced executor wrapper.
- `packages/rest`: Hono HTTP wrapper.
- `packages/claude-plugin`: hooks, MCP configuration, and Skill.
- `examples/grok-bot`: offline bot/tool-loop reference.

Generic `http-post`, `social-publish`, `email-send`, and `file-write` surfaces validate ID shapes. They do not ship credentials or provider-specific readers. Register your own exact provider/account surface and observer; see [the adapter contract](docs/ARCHITECTURE.md).

The default audit is `.receipts/audit.jsonl`, configurable with `RECEIPTS_AUDIT_PATH`. Every stored record commits to the previous record's hash. A lock and compare-and-append guard concurrent claims. This detects edits within a retained chain, not a malicious rewrite of the entire file; externally anchored checkpoints are a future hosted-store concern. File access and the adapter are trusted boundaries.

## Free forever

The full mechanism, local storage, MCP, SDK, and REST are MIT-licensed and free forever. No signup. Team and Enterprise will add hosted visibility, fleet oversight, retention, and export—not a paywall around verification. Those services are outside v1.

[Architecture](docs/ARCHITECTURE.md) · [Release status](docs/RELEASE.md) · [MIT license](LICENSE)
