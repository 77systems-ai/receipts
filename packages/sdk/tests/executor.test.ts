import assert from "node:assert/strict";
import test from "node:test";
import { bind, registerSurface, type AuditEntry, type AuditStore, type OutwardWrite } from "@77systems/receipts-core";
import { createReceipts, digestPayload, DuplicateWriteError, VerificationPendingError } from "../src/index.js";

class TestStore implements AuditStore {
  entries: AuditEntry[] = [];
  failAppend = false;
  read(): readonly AuditEntry[] { return structuredClone(this.entries); }
  append(entry: AuditEntry, expectedLength?: number): void {
    if (this.failAppend) throw new Error("Audit unavailable");
    if (expectedLength !== undefined && expectedLength !== this.entries.length) throw new Error("Audit conflict");
    this.entries.push(structuredClone(entry));
  }
}

let surfaceCounter = 0;
function surface(observe?: (write: OutwardWrite) => { destinationId: string; packageDigest: string; evidence: Array<{ source: "provider"; detail: string; destinationId: string; packageDigest: string }> }) {
  const name = `sdk-test-${++surfaceCounter}`;
  registerSurface({ name, idPattern: /^post-\d+$/, observe });
  return name;
}

function observation(write: OutwardWrite) {
  return {
    destinationId: "post-1",
    packageDigest: write.packageDigest,
    evidence: [{ source: "provider" as const, detail: "Read exact destination payload", destinationId: "post-1", packageDigest: write.packageDigest }],
  };
}

test("uncertain execution cannot claim completion, cannot retry, and resolves only by observing existing object", async () => {
  const store = new TestStore();
  let writes = 0;
  let reads = 0;
  const name = surface((write) => { reads += 1; return observation(write); });
  const client = createReceipts({ store });
  const payload = { text: "Approved post" };
  const options = {
    surface: name, attemptId: "attempt-1", idempotencyKey: "post-action-1", payload,
    execute() { writes += 1; throw new Error("Response lost after destination accepted write"); },
  };
  const pending = await client.execute(options);
  assert.equal(pending.classification.verdict, "delivery_unknown");
  assert.equal(pending.classification.mayAutoRetry, false);
  assert.equal(pending.classification.maySecondWrite, false);
  assert.equal(reads, 0);
  assert.throws(() => client.claimComplete(pending), VerificationPendingError);
  await assert.rejects(client.execute(options), DuplicateWriteError);
  await assert.rejects(createReceipts({ store }).execute({ ...options, attemptId: "attempt-2" }), DuplicateWriteError);
  await assert.rejects(client.execute({ ...options, attemptId: "attempt-3", idempotencyKey: "new-key" }), DuplicateWriteError);
  const complete = await client.reconcile({ surface: name, attemptId: "attempt-1", payload });
  assert.equal(complete.classification.verdict, "complete");
  assert.equal(client.claimComplete(complete), "post-1");
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.deepEqual(store.read().map((entry) => entry.event), ["attempt", "classification", "observation", "binding", "classification"]);
});

test("executor success flags and invented receipt fields are ignored without read-back", async () => {
  const store = new TestStore();
  const client = createReceipts({ store });
  const pending = await client.execute({
    surface: surface(), attemptId: "claimed-success", idempotencyKey: "claimed-success", payload: { x: 1 },
    execute: () => ({ status: "posted", destinationId: "post-1", packageDigest: digestPayload({ x: 1 }) }),
  });
  assert.equal(pending.classification.verdict, "delivery_unknown");
  assert.equal(pending.destinationId, null);
  assert.throws(() => client.claimComplete(pending));
});

test("a successful callback still needs matching provider observation before complete", async () => {
  const client = createReceipts({ store: new TestStore() });
  const complete = await client.execute({
    surface: surface(observation), attemptId: "success", idempotencyKey: "success", payload: { text: "Hello" }, execute: () => undefined,
  });
  assert.equal(complete.classification.verdict, "complete");
  assert.equal(client.claimComplete(complete), "post-1");
});

test("read-back with the wrong payload or missing evidence cannot bind", async () => {
  const store = new TestStore();
  const client = createReceipts({ store });
  const wrong = surface((write) => observation({ ...write, packageDigest: digestPayload({ wrong: true }) }));
  const result = await client.execute({ surface: wrong, attemptId: "mismatch", idempotencyKey: "mismatch", payload: { right: true }, execute() {} });
  assert.equal(result.classification.verdict, "package_unverified");
  assert.equal(result.destinationId, "post-1");
  assert.ok(!store.read().some((entry) => entry.event === "binding"));
  const noEvidence = surface((write) => ({ ...observation(write), evidence: [] }));
  const absent = await client.execute({ surface: noEvidence, attemptId: "missing", idempotencyKey: "missing", payload: { right: true }, execute() {} });
  assert.equal(absent.classification.verdict, "delivery_unknown");
});

test("audit claim failure prevents execution and audit result failure cannot claim success", async () => {
  const store = new TestStore();
  store.failAppend = true;
  const client = createReceipts({ store });
  let writes = 0;
  await assert.rejects(client.execute({
    surface: surface(observation), attemptId: "audit-fail", idempotencyKey: "audit-fail", payload: { p: 1 }, execute() { writes += 1; },
  }), /Audit unavailable/);
  assert.equal(writes, 0);
  store.failAppend = false;
  await assert.rejects(client.execute({
    surface: surface(observation), attemptId: "result-fail", idempotencyKey: "result-fail", payload: { p: 2 },
    execute() { writes += 1; store.failAppend = true; },
  }), /Audit unavailable/);
  assert.equal(writes, 1);
  assert.equal(store.entries[0]!.verdict, "delivery_unknown");
});

test("contradictory or missing observed digest preserves placement without leaving bindable evidence", async () => {
  for (const declaredDigest of [digestPayload({ wrong: true }), undefined]) {
    const store = new TestStore();
    const client = createReceipts({ store });
    const name = surface((write) => ({ ...observation(write), packageDigest: declaredDigest as string }));
    const payload = { intended: "package" };
    const result = await client.execute({
      surface: name, attemptId: "contradictory", idempotencyKey: "contradictory", payload, execute() {},
    });
    assert.equal(result.classification.verdict, "package_unverified");
    assert.equal(result.destinationId, "post-1");
    assert.throws(() => bind("post-1", digestPayload(payload), store), /No audited/);
  }
});

test("parallel calls through separate clients share the durable execution guard", async () => {
  const store = new TestStore();
  let writes = 0;
  const options = {
    surface: surface(), attemptId: "concurrent", idempotencyKey: "concurrent", payload: { x: 1 },
    async execute() { writes += 1; await Promise.resolve(); },
  };
  const results = await Promise.allSettled([createReceipts({ store }).execute(options), createReceipts({ store }).execute(options)]);
  assert.equal(writes, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("reconciliation cannot substitute a changed package or a different supplied object", async () => {
  const store = new TestStore();
  const client = createReceipts({ store });
  const name = surface(observation);
  await client.execute({ surface: name, attemptId: "original", idempotencyKey: "original", payload: { approved: true }, execute() { throw new Error("timeout"); } });
  await assert.rejects(client.reconcile({ surface: name, attemptId: "original", payload: { approved: false } }), /differs/);
  const mismatch = await client.reconcile({ surface: name, attemptId: "original", payload: { approved: true }, destinationId: "post-2" });
  assert.equal(mismatch.classification.verdict, "delivery_unknown");
  assert.ok(!store.read().some((entry) => entry.event === "binding"));
  assert.equal(mismatch.destinationId, null);
});
