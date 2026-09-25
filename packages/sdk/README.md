# Receipts SDK

Wrap the actual outward-write call so an agent cannot return a completion receipt without observation, binding, and a durable audit entry. The SDK computes `sha256:` plus the SHA-256 hex digest of the approved payload using deterministic JSON serialization. It never retries writes.

```ts
import { registerSurface } from "@77systems/receipts-core";
import { createReceipts, digestPayload } from "@77systems/receipts-sdk";

registerSurface({
  name: "my-posts",
  idPattern: /^post-[0-9]+$/,
  async observe(write) {
    // Your trusted adapter reads the actual provider, including the account.
    const post = await destination.readByActionKey(write.idempotencyKey);
    const observedDigest = digestPayload(post.approvedPayloadFields);
    return {
      destinationId: post.id,
      packageDigest: observedDigest,
      evidence: [{
        source: "provider", detail: "Authenticated account and payload read-back",
        destinationId: post.id, packageDigest: observedDigest,
      }],
    };
  },
});

const receipts = createReceipts(); // Default append-only JSONL audit store.
const receipt = await receipts.execute({
  surface: "my-posts",
  attemptId: "attempt-001",
  idempotencyKey: "account-42:approved-post-001",
  payload: { text: "The approved post" },
  execute: ({ payload, idempotencyKey }) => destination.post(payload, { idempotencyKey }),
});

// Throws for uncertain or unverified results; only then may the bot say posted.
const destinationId = receipts.claimComplete(receipt);
```

`destination` above is your provider client. For a runnable example without credentials or network requests, run `npm run demo` from `examples/grok-bot` in the source repository.

## Uncertain writes

An exception after the executor callback starts becomes `delivery_unknown` automatically. Even a callback that returns normally must pass the registered observer before it can complete. An executor's success flag, object ID, or asserted digest is never evidence. The original error is not copied into audit text, where it could disclose request credentials.

Call `receipts.reconcile({ surface, attemptId, payload, destinationId? })` to read and bind the existing destination object. A human-supplied ID is a pointer for the adapter to inspect, not a bypass around payload verification. Reconciliation never invokes the write callback.

The observer must compute its returned digest from the real read-back fields, verify the correct provider/account, and return evidence naming the same destination ID and digest. The SDK verifies those structural bindings; it cannot authenticate an adapter's implementation. Register only trusted adapters.

## Execution and persistence boundary

Before calling the executor, the SDK atomically appends an uncertain execution claim. A crash at any later point leaves an unknown attempt that requires observation. A duplicate attempt ID, stable idempotency key, or same surface/payload digest is refused before execution. All processes must share the same durable store and stable action keys. Custom stores must implement the `expectedLength` compare-and-append contract atomically.

Use account identity and intended destination in the approved payload and scope idempotency keys to the logical action. This conservative wrapper also blocks intentionally repeated identical packages; give a genuinely new approved action an explicit identity in its payload. It does not expose a write-retry or rearm method.

Payloads are detached and recursively frozen before dispatch. Only plain JSON values are supported; cycles, undefined values, non-finite numbers, sparse arrays, getters, class instances, and symbol keys are rejected. Object keys are sorted; array order matters. The serialization version is `receipts-json-v1` and is not advertised as RFC 8785.

If any required audit append fails, the wrapper throws and cannot return completion. `claimComplete` rechecks the persisted classification and binding. The wrapper enforces its own code path; it cannot prevent application code from calling a provider directly or a language model from writing an unsupported sentence outside that path.
