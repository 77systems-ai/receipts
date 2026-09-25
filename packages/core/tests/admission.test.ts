import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIdempotencyRegistry, createAuditEntry, digestPackage, evaluatePolicy, exportAuditChain,
  JsonlAuditStore, MemoryAuditStore, observeDestination, record, validateAuditChain,
  type ApprovedAction, type AuditEntry, type AuditStore, type ClaimDecision, type ClaimLease,
} from "../src/index.js";

const start = Date.parse("2026-09-25T10:00:00.000Z");
const action: ApprovedAction = {
  surface: "social-publish", attemptId: "claim-attempt", actionId: "123e4567-e89b-42d3-a456-426614174000",
  destinationAccount: "social:account-1", approvalId: "approval-1", packageDigest: digestPackage("Private approved package"),
};
const errorCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
function won(result: ClaimDecision): ClaimLease {
  assert.equal(result.verdict, "CLAIMED");
  if (result.verdict !== "CLAIMED") throw Error("Expected a claim.");
  return result.claim;
}
function nextAction(): ApprovedAction {
  return { ...action, actionId: randomUUID(), attemptId: randomUUID(), approvalId: randomUUID() };
}

for (const backend of ["memory", "jsonl"] as const) {
  function makeStore(context: { after(fn: () => void): void }): AuditStore {
    if (backend === "memory") return new MemoryAuditStore();
    const directory = mkdtempSync(join(tmpdir(), "receipts-admission-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    return new JsonlAuditStore(join(directory, "audit.jsonl"));
  }

  test(`${backend}: claim, dispatch, bound completion, then DUPLICATE with no new dispatch`, async (context) => {
    const store = makeStore(context);
    let now = start;
    const registry = createIdempotencyRegistry({ store, ttlMs: 1000, now: () => now });
    const lease = won(registry.claim(action));
    assert.throws(() => registry.complete(lease, "post-1"), errorCode("claim_not_dispatched"));
    assert.equal(registry.dispatch(lease).verdict, "AUTHORIZED");
    assert.throws(() => registry.complete(lease, "post-1"), errorCode("observation_required"));
    await observeDestination({ surface: action.surface, read: () => ({ destinationAccount: action.destinationAccount,
      destinationId: "post-1", packageDigest: action.packageDigest, observedAt: new Date(now).toISOString() }) }, action, store);
    const completion = registry.complete(lease, "post-1");
    assert.equal(completion.verdict, "COMPLETED");
    assert.deepEqual(registry.completeVerified(action, "post-1"), completion, "Completion is idempotent after restart.");
    now += 10_000;
    const duplicate = registry.claim({ ...action, attemptId: "second-attempt" });
    assert.equal(duplicate.verdict, "DUPLICATE");
    assert.equal(duplicate.reason, "completed");
    assert.equal(store.read().filter((entry) => entry.event === "attempt").length, 1);
    validateAuditChain(exportAuditChain(store));
  });

  test(`${backend}: unused crash reservation expires, increments fencing, rejects stale owners`, (context) => {
    const store = makeStore(context);
    let now = start;
    const firstRegistry = createIdempotencyRegistry({ store, ttlMs: 100, now: () => now });
    const stale = won(firstRegistry.claim(action));
    const otherRegistry = createIdempotencyRegistry({ store, ttlMs: 100, now: () => now });
    assert.equal(otherRegistry.claim(action).verdict, "DUPLICATE");
    now += 101;
    const fresh = won(otherRegistry.claim(action));
    assert.equal(fresh.fence, stale.fence + 1);
    assert.notEqual(fresh.token, stale.token);
    assert.notEqual(fresh.leaseId, stale.leaseId);
    assert.equal(store.read().filter((entry) => entry.event === "claim_expired").length, 1);
    assert.throws(() => firstRegistry.dispatch(stale), errorCode("stale_claim"));
    assert.throws(() => firstRegistry.release(stale), errorCode("stale_claim"));
    assert.equal(otherRegistry.dispatch(fresh).verdict, "AUTHORIZED");
    const text = JSON.stringify(exportAuditChain(store));
    assert.ok(!text.includes(stale.token));
    assert.ok(!text.includes(fresh.token));
    assert.ok(text.includes(digestPackage(fresh.token)));
  });

  test(`${backend}: dispatched uncertainty cannot be released or become retryable when TTL expires`, (context) => {
    const store = makeStore(context);
    let now = start;
    const registry = createIdempotencyRegistry({ store, ttlMs: 10, now: () => now });
    const lease = won(registry.claim(action));
    registry.dispatch(lease);
    now += 60_000;
    assert.throws(() => registry.release(lease), errorCode("claim_dispatched"));
    assert.throws(() => registry.dispatch(lease), errorCode("claim_dispatched"));
    const duplicate = registry.claim({ ...action, attemptId: "crash-retry" });
    assert.equal(duplicate.verdict, "DUPLICATE");
    assert.equal(duplicate.reason, "dispatched");
    assert.equal(store.read().filter((entry) => entry.event === "attempt").length, 1);
    assert.equal(store.read().filter((entry) => entry.event === "claim_expired").length, 0);
  });

  test(`${backend}: unused release permits a new fenced owner; expired leases cannot dispatch`, (context) => {
    const store = makeStore(context);
    let now = start;
    const registry = createIdempotencyRegistry({ store, ttlMs: 100, now: () => now });
    const first = won(registry.claim(action));
    assert.equal(registry.release(first).verdict, "RELEASED");
    const second = won(registry.claim(action));
    assert.equal(second.fence, first.fence + 1);
    now += 100;
    assert.throws(() => registry.dispatch(second), errorCode("claim_expired"));
    assert.equal(store.read().filter((entry) => entry.event === "attempt").length, 0);
    assert.equal(store.read().at(-1)!.event, "claim_expired");
  });

  test(`${backend}: policy blocks exact account with named audit rule; default is permissive`, (context) => {
    const store = makeStore(context);
    const registry = createIdempotencyRegistry({ store, now: () => start });
    const lease = won(registry.claim(action));
    const denied = registry.dispatch(lease, { rules: [{ id: "restricted-destination", effect: "block", destinationAccount: action.destinationAccount }] });
    assert.equal(denied.verdict, "policy_denied");
    assert.equal(denied.ruleId, "restricted-destination");
    assert.equal(store.read().at(-1)!.event, "policy_denied");
    assert.equal(store.read().at(-1)!.admission!.ruleId, denied.ruleId);
    assert.equal(store.read().filter((entry) => entry.event === "attempt").length, 0);
    assert.equal(registry.dispatch(lease).verdict, "AUTHORIZED");
    validateAuditChain(exportAuditChain(store));
  });

  test(`${backend}: shared rate budgets deny second dispatch, expire by window, and scope by account`, (context) => {
    const store = makeStore(context);
    let now = start;
    const one = createIdempotencyRegistry({ store, ttlMs: 10_000, now: () => now });
    const two = createIdempotencyRegistry({ store, ttlMs: 10_000, now: () => now });
    const policy = { rateLimits: [{ id: "one-per-second", maxWrites: 1, windowMs: 1000, surface: action.surface, destinationAccount: action.destinationAccount }] };
    one.dispatch(won(one.claim(action)), policy);
    const next = won(two.claim(nextAction()));
    const denied = two.dispatch(next, policy);
    assert.equal(denied.verdict, "policy_denied");
    assert.equal(denied.ruleId, "one-per-second");
    const otherAccount = won(two.claim({ ...nextAction(), destinationAccount: "social:account-2" }));
    assert.equal(two.dispatch(otherAccount, policy).verdict, "AUTHORIZED");
    now += 1000;
    assert.equal(two.dispatch(next, policy).verdict, "AUTHORIZED");
    assert.equal(store.read().filter((entry) => entry.event === "attempt").length, 3);
  });

  test(`${backend}: wire/direct append cannot forge registry release or policy budget authority`, (context) => {
    const store = makeStore(context);
    const registry = createIdempotencyRegistry({ store, now: () => start });
    const lease = won(registry.claim(action));
    const claimEntry = store.read().at(-1)!;
    const forged: AuditEntry = { ...claimEntry, id: randomUUID(), event: "claim_released", admission: { verdict: "RELEASED" } };
    assert.throws(() => record(forged, store), errorCode("protected_admission"));
    assert.throws(() => store.append(forged), errorCode("protected_admission"));
    assert.throws(() => registry.dispatch({ ...lease, token: "wrong-token" }), errorCode("stale_claim"));
    assert.equal(registry.claim(action).verdict, "DUPLICATE");
  });

  test(`${backend}: changed payload or provider key still gives an audited DUPLICATE for the same action`, (context) => {
    const store = makeStore(context);
    const registry = createIdempotencyRegistry({ store, now: () => start });
    const original = { ...action, idempotencyKey: "original-provider-key" };
    const lease = won(registry.claim(original));
    registry.dispatch(lease);
    const prior = store.read();
    for (const changed of [{ ...original, packageDigest: digestPackage("Different approved payload") },
      { ...original, idempotencyKey: "different-provider-key" }]) {
      const refusal = registry.claim(changed);
      assert.equal(refusal.verdict, "DUPLICATE");
      const entry = store.read().find((item) => item.id === refusal.auditEntryId)!;
      assert.equal(entry.event, "duplicate");
      assert.notEqual(entry.attemptId, original.attemptId);
      assert.equal(entry.actionId, original.actionId);
    }
    assert.deepEqual(store.read().slice(0, prior.length), prior);
    assert.equal(store.read().filter((entry) => entry.event === "attempt").length, 1);
  });
}

test("policy allow rules do not silently deny other actions; explicit default block and deny precedence work", () => {
  const allow = { id: "allow-github", effect: "allow" as const, surface: "http-post" };
  assert.equal(evaluatePolicy(action, { rules: [allow] }).verdict, "allowed");
  assert.deepEqual(evaluatePolicy(action, { defaultEffect: "block", rules: [allow] }), { verdict: "policy_denied", ruleId: "default-policy" });
  assert.equal(evaluatePolicy(action, { defaultEffect: "block", rules: [{ ...allow, surface: action.surface }] }).verdict, "allowed");
  assert.deepEqual(evaluatePolicy(action, { rules: [{ ...allow, surface: action.surface }, { id: "block-social", effect: "block", surface: action.surface }] }), { verdict: "policy_denied", ruleId: "block-social" });
  assert.throws(() => evaluatePolicy(action, { rules: [{ ...allow, id: "https://host/token=SECRET" }] }), errorCode("invalid_policy"));
});

test("opaque action identities retain account scope and UUID case-insensitive deduplication", () => {
  const registry = createIdempotencyRegistry({ store: new MemoryAuditStore(), now: () => start });
  registry.claim(action);
  assert.equal(registry.claim({ ...action, attemptId: "capitalized", actionId: action.actionId.toUpperCase() }).verdict, "DUPLICATE");
  assert.equal(registry.claim({ ...action, attemptId: "other-account", destinationAccount: "social:account-2" }).verdict, "CLAIMED");
});

test("legacy dispatched audit entries cannot be reclaimed by the new registry", () => {
  const store = new MemoryAuditStore();
  record(createAuditEntry({ ...action, writeMayHaveHappened: true }, "attempt"), store);
  const registry = createIdempotencyRegistry({ store, now: () => start });
  assert.equal(registry.claim(action).verdict, "DUPLICATE");
});

test("export preserves JSONL envelopes and detects entry, link, and head tampering offline", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-chain-export-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.jsonl");
  const store = new JsonlAuditStore(path);
  const registry = createIdempotencyRegistry({ store, now: () => start });
  registry.dispatch(won(registry.claim(action)));
  const exported = exportAuditChain(store);
  assert.deepEqual(exported.envelopes, readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)));
  validateAuditChain(exported);
  for (const corrupt of [
    (chain: typeof exported) => { chain.envelopes[0]!.entry.actionId = randomUUID(); },
    (chain: typeof exported) => { chain.envelopes[1]!.previousHash = "a".repeat(64); },
    (chain: typeof exported) => { chain.head.count--; },
  ]) {
    const copy = structuredClone(exported);
    corrupt(copy);
    assert.throws(() => validateAuditChain(copy), errorCode("audit_corrupt"));
  }
});

async function raceWorkers(path: string, rateLimit: boolean): Promise<string[]> {
  const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
  const children = [0, 1].map((index) => {
    const workerAction = rateLimit ? { ...action, actionId: randomUUID(), attemptId: `worker-${index}`, approvalId: `approval-${index}` } : action;
    const source = `import {createIdempotencyRegistry, JsonlAuditStore} from ${JSON.stringify(moduleUrl)};
      const registry = createIdempotencyRegistry({store:new JsonlAuditStore(${JSON.stringify(path)}),ttlMs:60000});
      const action = ${JSON.stringify(workerAction)};
      const lease = ${rateLimit ? "registry.claim(action).claim" : "undefined"};
      process.send('ready');
      process.on('message', () => {
        try {
          const result = ${rateLimit ? "registry.dispatch(lease,{rateLimits:[{id:'shared-window',maxWrites:1,windowMs:60000,surface:action.surface}]})" : "registry.claim(action)"};
          process.send({verdict:result.verdict}); process.disconnect();
        } catch(error) { process.send({error:error.code||String(error)}); process.disconnect(); }
      });`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let errors = "";
    child.stderr?.on("data", (data) => { errors += data; });
    const ready = new Promise<void>((resolve, reject) => {
      child.on("message", (message) => { if (message === "ready") resolve(); });
      child.once("error", reject);
      child.once("exit", (code) => { if (code !== 0) reject(Error(errors || `Worker exited ${code}`)); });
    });
    const result = new Promise<string>((resolve, reject) => {
      child.on("message", (message) => { if (message && typeof message === "object") {
        if ("verdict" in message) resolve(String(message.verdict));
        else if ("error" in message) reject(Error(String(message.error)));
      } });
      child.once("error", reject);
      child.once("exit", (code) => { if (code !== 0) reject(Error(errors || `Worker exited ${code}`)); });
    });
    return { child, ready, result };
  });
  await Promise.all(children.map((worker) => worker.ready));
  for (const worker of children) worker.child.send("go");
  return Promise.all(children.map((worker) => worker.result));
}

test("separate Node processes race one JSONL action: exactly one claim wins", { timeout: 15_000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-process-race-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.jsonl");
  assert.deepEqual((await raceWorkers(path, false)).sort(), ["CLAIMED", "DUPLICATE"]);
  assert.equal(new JsonlAuditStore(path).read().filter((entry) => entry.event === "claim").length, 1);
  validateAuditChain(exportAuditChain(new JsonlAuditStore(path)));
});

test("separate Node processes share one atomic policy budget: exactly one dispatch wins", { timeout: 15_000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-budget-race-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.jsonl");
  assert.deepEqual((await raceWorkers(path, true)).sort(), ["AUTHORIZED", "policy_denied"]);
  assert.equal(new JsonlAuditStore(path).read().filter((entry) => entry.event === "attempt").length, 1);
});
