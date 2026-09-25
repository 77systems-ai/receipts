# Receipts connector conformance

A public behavioral standard for destination connectors. Run your real connector implementation against a controllable provider fixture with Node's built-in test runner. The suite covers wrong account, changed content, read timeout, forged evidence, a lost response and blocked duplicate, separately approved repeated content, and immutable recheck history.

```ts
import { connectorConformance } from "@77systems/receipts-conformance";

connectorConformance("my provider", (context) => ({
  connector,                 // Real connector using a mocked provider transport.
  payload: approvedPayload,  // Exactly the JSON payload the connector hashes.
  destinationAccount: "provider:account",
  destinationId: "provider:account:object-1",
  locator: { number: 1 },     // Optional transient provider coordinates.
  write: () => fixture.acceptWrite(),
  writes: () => fixture.writeCount,
  reads: () => fixture.readCount,
  changeContent: () => fixture.editExistingObject(),
  setWrongAccount: () => fixture.respondFromOtherAccount(),
  setReadFailure: (message) => fixture.failRead(message),
  dispose: () => fixture.restore(), // Optional, awaited after each test.
}));
```

The factory is called once per test and receives Node's `TestContext`. It may be asynchronous. Use a fresh, isolated provider state each time. `write`, state controls, and `dispose` may return promises. Tests run sequentially within the suite. If you patch a process-global transport, restore it using `dispose` or `context.after`.

The fixture's read/write counters must measure actual transport calls. State controls must alter the provider response, not mutate returned receipt fields or bypass the connector. `changeContent` preserves account and object identity. `setWrongAccount` returns a foreign account or repository. `setReadFailure` throws the supplied private marker so the suite can check that errors never enter the audit.

Every connector must pass this suite and its own provider response validation tests. Passing a deterministic fixture does not prove a live provider write occurred. The separate GitHub live example verifies that sequence against the real API and saves local inspectable receipts.
