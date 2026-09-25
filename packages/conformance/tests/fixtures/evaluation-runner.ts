import { writeFileSync } from "node:fs";
import { registerSurface } from "@77systems/receipts-core";
import { digestPayload } from "@77systems/receipts-sdk";
import { connectorConformance } from "../../src/index.js";

const mode = process.env.EVALUATION_TEST_MODE;
const path = process.env.EVALUATION_TEST_OUTPUT!;
const ids: string[] = [];
let count = 0;
connectorConformance("controlled evaluation fixture", () => {
  if (mode === "setup-failure") throw new Error("sensitive-error-content-never-emit-7fa402");
  const surface = `evaluation-fixture-${++count}`;
  registerSurface({ name: surface, idPattern: /^fixture:[0-9]+$/ });
  const payload = { text: "private-payload-never-emit-dc582a" };
  let current = payload;
  let account = "fixture:account";
  let failure: string | undefined;
  let reads = 0;
  let writes = 0;
  return {
    connector: { surface, read(request) {
      reads++;
      ids.push(request.actionId);
      if (failure || mode === "false-block") throw new Error(failure ?? "sensitive-error-content-never-emit-7fa402");
      return { destinationId: "fixture:1", destinationAccount: account,
        packageDigest: digestPayload(mode === "false-complete" ? payload : current), observedAt: "2026-09-25T10:42:00.000Z" };
    } },
    payload, destinationAccount: account, destinationId: "fixture:1",
    write() { writes++; }, reads: () => reads, writes: () => writes,
    changeContent() { current = { text: "edited-private-payload" }; },
    setWrongAccount() { account = "fixture:other-account"; },
    setReadFailure(message) { failure = message; },
  };
}, {
  connectorVersion: "0.3.0", seed: process.env.EVALUATION_TEST_SEED ?? "evaluation-test-seed",
  evaluationPath: path,
  onEvaluation() { writeFileSync(`${path}.ids`, JSON.stringify(ids)); },
});
