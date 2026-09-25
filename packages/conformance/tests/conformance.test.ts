import { registerSurface } from "@77systems/receipts-core";
import { digestPayload } from "@77systems/receipts-sdk";
import { connectorConformance } from "../src/index.js";

let counter = 0;
connectorConformance("reference fixture", () => {
  const surface = `conformance-fixture-${++counter}`;
  registerSurface({ name: surface, idPattern: /^fixture:object:[0-9]+$/ });
  const payload = { text: "Approved fixture content" };
  let current = payload;
  let account = "fixture:account";
  let failed: string | undefined;
  let writes = 0;
  let reads = 0;
  return {
    connector: { surface, read() {
      reads += 1;
      if (failed) throw new Error(failed);
      if (!writes) throw new Error("No destination object");
      return { destinationAccount: account, destinationId: "fixture:object:1", packageDigest: digestPayload(current), observedAt: new Date().toISOString() };
    } },
    payload, destinationAccount: "fixture:account", destinationId: "fixture:object:1",
    write() { writes += 1; }, writes: () => writes, reads: () => reads,
    changeContent() { current = { text: "Edited fixture content" }; },
    setWrongAccount() { account = "fixture:other-account"; },
    setReadFailure(message: string) { failed = message; },
  };
});
