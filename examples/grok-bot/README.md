# Grok bot: enforced receipt gate

This is a free, offline reference scaffold for the outward-write tool in a Grok bot. No existing Grok bot template was present in the supplied workspace, so this example is newly written rather than presented as a rewired third-party template. It does not call xAI, charge credits, or publish a real post.

From the repository root:

```sh
npm install
npm run build
npm run demo --workspace @77systems/receipts-grok-example
```

The executable assertions demonstrate the production failure pattern with deterministic fixtures:

1. One post is accepted by the simulated destination, then the response is lost.
2. The SDK records `delivery_unknown` automatically; the bot's completion gate throws.
3. A second execution is refused before the outward-write callback runs.
4. The registered observer reads the existing object and hashes its actual payload.
5. Observation and binding are appended to the audit; only then can the bot claim completion. The destination received exactly one write.

Each run writes a separate local JSONL audit file in the system temporary directory and prints its path. Nothing deletes or replaces earlier receipts. The receipt explicitly says `evidenceSource: "host-supplied"` and `independentlyVerified: false`. “Provider” labels describe the simulated destination and cannot promote the fixture into independent platform proof.

For a real bot, preserve the `receipts.execute` and `receipts.claimComplete` gate inside the tool implementation. Replace the simulated write and observer with authenticated provider adapters, and provide the exact `destinationAccount`, stable caller-generated action UUID, and explicit `approvalId`. A new approved action gets a new UUID and approval even when its content is identical. Use a core-executed destination connector for independent proof; see the [GitHub integration](../github-issues). Grok's generated tool request can propose content; it must not manufacture the returned completion receipt. All processes handling the same actions must share a durable audit backend. The wrapper cannot govern provider calls that bypass it.
