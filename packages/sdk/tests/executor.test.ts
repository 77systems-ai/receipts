import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bind, getReceipt, registerSurface, type AuditEntry, type AuditStore, type OutwardWrite } from "@77systems/receipts-core";
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
function identity(destinationAccount = "provider:account-1") {
  return { actionId: randomUUID(), destinationAccount, approvalId: `approval-${randomUUID()}` };
}
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
    ...identity(), surface: name, attemptId: "attempt-1", idempotencyKey: "post-action-1", payload,
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
  assert.deepEqual(store.read().map((entry) => entry.event), ["claim", "attempt", "classification", "duplicate", "duplicate", "duplicate", "observation", "binding", "classification", "claim_completed"]);
});

test("executor success flags and invented receipt fields are ignored without read-back", async () => {
  const store = new TestStore();
  const client = createReceipts({ store });
  const pending = await client.execute({
    ...identity(), surface: surface(), attemptId: "claimed-success", idempotencyKey: "claimed-success", payload: { x: 1 },
    execute: () => ({ status: "posted", destinationId: "post-1", packageDigest: digestPayload({ x: 1 }) }),
  });
  assert.equal(pending.classification.verdict, "delivery_unknown");
  assert.equal(pending.destinationId, null);
  assert.throws(() => client.claimComplete(pending));
});

test("a successful callback still needs matching provider observation before complete", async () => {
  const client = createReceipts({ store: new TestStore() });
  const complete = await client.execute({
    ...identity(), surface: surface(observation), attemptId: "success", idempotencyKey: "success", payload: { text: "Hello" }, execute: () => undefined,
  });
  assert.equal(complete.classification.verdict, "complete");
  assert.equal(client.claimComplete(complete), "post-1");
});

test("read-back with the wrong payload or missing evidence cannot bind", async () => {
  const store = new TestStore();
  const client = createReceipts({ store });
  const wrong = surface((write) => observation({ ...write, packageDigest: digestPayload({ wrong: true }) }));
  const result = await client.execute({ ...identity(), surface: wrong, attemptId: "mismatch", idempotencyKey: "mismatch", payload: { right: true }, execute() {} });
  assert.equal(result.classification.verdict, "package_unverified");
  assert.equal(result.destinationId, "post-1");
  assert.ok(!store.read().some((entry) => entry.event === "binding"));
  const noEvidence = surface((write) => ({ ...observation(write), evidence: [] }));
  const absent = await client.execute({ ...identity(), surface: noEvidence, attemptId: "missing", idempotencyKey: "missing", payload: { right: true }, execute() {} });
  assert.equal(absent.classification.verdict, "delivery_unknown");
});

test("audit claim failure prevents execution and audit result failure cannot claim success", async () => {
  const store = new TestStore();
  store.failAppend = true;
  const client = createReceipts({ store });
  let writes = 0;
  await assert.rejects(client.execute({
    ...identity(), surface: surface(observation), attemptId: "audit-fail", idempotencyKey: "audit-fail", payload: { p: 1 }, execute() { writes += 1; },
  }), /Audit unavailable/);
  assert.equal(writes, 0);
  store.failAppend = false;
  await assert.rejects(client.execute({
    ...identity(), surface: surface(observation), attemptId: "result-fail", idempotencyKey: "result-fail", payload: { p: 2 },
    execute() { writes += 1; store.failAppend = true; },
  }), /Audit unavailable/);
  assert.equal(writes, 1);
  assert.equal(store.entries.find(entry=>entry.event === "attempt")!.verdict, "delivery_unknown");
});

test("contradictory or missing observed digest preserves placement without leaving bindable evidence", async () => {
  for (const declaredDigest of [digestPayload({ wrong: true }), undefined]) {
    const store = new TestStore();
    const client = createReceipts({ store });
    const name = surface((write) => ({ ...observation(write), packageDigest: declaredDigest as string }));
    const payload = { intended: "package" };
    const result = await client.execute({
      ...identity(), surface: name, attemptId: "contradictory", idempotencyKey: "contradictory", payload, execute() {},
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
    ...identity(), surface: surface(), attemptId: "concurrent", idempotencyKey: "concurrent", payload: { x: 1 },
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
  await client.execute({ ...identity(), surface: name, attemptId: "original", idempotencyKey: "original", payload: { approved: true }, execute() { throw new Error("timeout"); } });
  await assert.rejects(client.reconcile({ surface: name, attemptId: "original", payload: { approved: false } }), /differs/);
  const mismatch = await client.reconcile({ surface: name, attemptId: "original", payload: { approved: true }, destinationId: "post-2" });
  assert.equal(mismatch.classification.verdict, "delivery_unknown");
  assert.ok(!store.read().some((entry) => entry.event === "binding"));
  assert.equal(mismatch.destinationId, null);
});

test("the same approved action stays blocked across attempts, keys, payloads, and UUID case", async () => {
  const store = new TestStore();
  const client = createReceipts({ store });
  let writes = 0;
  const options = { ...identity(), surface: surface(), attemptId: "uncertain", payload: { text: "daily" },
    execute() { writes += 1; throw new Error("lost response"); } };
  await client.execute(options);
  for (const changes of [
    { attemptId: "second" },
    { attemptId: "third", idempotencyKey: "new-key" },
    { attemptId: "fourth", payload: { text: "changed" } },
    { attemptId: "fifth", actionId: options.actionId.toUpperCase() },
  ]) await assert.rejects(client.execute({ ...options, ...changes }), DuplicateWriteError);
  assert.equal(writes, 1);
});

test("identical content with a new action and approval is allowed while recycled approval is blocked", async () => {
  const store = new TestStore();
  const client = createReceipts({ store });
  let writes = 0;
  const options = { ...identity(), surface: surface(), attemptId: "day-one", payload: { text: "daily" },
    execute() { writes += 1; } };
  const first = await client.execute(options);
  await assert.rejects(client.execute({ ...options, attemptId: "recycled-approval", actionId: randomUUID() }), DuplicateWriteError);
  const second = await client.execute({ ...options, ...identity(), attemptId: "day-two" });
  assert.equal(first.packageDigest, second.packageDigest);
  assert.notEqual(first.actionId, second.actionId);
  assert.equal(writes, 2);
});

test("action identity is scoped to the exact destination account", async () => {
  const client = createReceipts({ store: new TestStore() });
  let writes = 0;
  const options = { ...identity(), surface: surface(), attemptId: "account-a", payload: { text: "hello" }, execute() { writes += 1; } };
  await client.execute(options);
  await client.execute({ ...options, destinationAccount: "provider:account-2", attemptId: "account-b", approvalId: "approval-account-b" });
  assert.equal(writes, 2);
});

test("caller UUID, destination account, and explicit approval are required before dispatch", async () => {
  const client = createReceipts({ store: new TestStore() });
  let writes = 0;
  const options = { ...identity(), surface: surface(), attemptId: "invalid", payload: { text: "hello" }, execute() { writes += 1; } };
  for (const changes of [{ actionId: "not-a-uuid" }, { destinationAccount: "" }, { approvalId: "" }]) {
    await assert.rejects(client.execute({ ...options, ...changes }));
  }
  assert.equal(writes, 0);
});

test("provider-labelled cooperative evidence cannot self-promote to independent proof", async () => {
  const store = new TestStore();
  const name = surface((write) => ({ ...observation(write), evidenceSource: "receipts-read", independentlyVerified: true }));
  const client = createReceipts({ store });
  const result = await client.execute({ ...identity(), surface: name, attemptId: "forged-source", payload: { text: "approved" }, execute() {} });
  assert.equal(result.classification.verdict, "complete");
  assert.equal(result.evidenceSource, "host-supplied");
  assert.equal(result.independentlyVerified, false);
  assert.ok(result.observedAt);
  assert.equal(client.claimComplete(result), "post-1");
  assert.throws(() => client.claimComplete(result, { requireIndependent: true }), VerificationPendingError);
  assert.throws(() => client.claimComplete({ ...result, evidenceSource: "receipts-read", independentlyVerified: true }), VerificationPendingError);
  assert.ok(store.read().every((entry) => entry.independentlyVerified !== true));
});

test("connector reads produce independently verified receipts and rechecks preserve the original", async () => {
  const store = new TestStore();
  const name = surface();
  const payload = { text: "approved" };
  let currentPayload = payload;
  let time = "2026-09-25T10:42:00.000Z";
  let reads = 0;
  const connector = { surface: name, read: () => {
    reads += 1;
    return { destinationId: "post-1", destinationAccount: "provider:account-1", packageDigest: digestPayload(currentPayload), observedAt: time };
  } };
  const client = createReceipts({ store, connector });
  const action = identity();
  await client.execute({ ...action, surface: name, attemptId: "trusted", payload, execute() { throw new Error("response lost"); } });
  const original = await client.reconcile({ surface: name, attemptId: "trusted", payload, destinationId: "post-1" });
  assert.equal(original.evidenceSource, "receipts-read");
  assert.equal(original.independentlyVerified, true);
  assert.equal(original.observedAt, time);
  assert.equal(client.claimComplete(original, { requireIndependent: true }), "post-1");
  assert.throws(() => client.claimComplete({ ...original, observedPackageDigest: digestPayload({ forged: true }) }), VerificationPendingError);
  const originalEntries = store.read();
  time = "2026-09-25T11:05:00.000Z";
  const same = await client.recheck({ surface: name, attemptId: "trusted", payload, destinationId: "post-1" });
  assert.equal(same.observedAt, time);
  assert.equal(same.classification.verdict, "complete");
  assert.equal(client.claimComplete(same), "post-1");
  assert.deepEqual(store.read().slice(0, originalEntries.length), originalEntries);
  currentPayload = { text: "edited after verification" };
  time = "2026-09-25T12:00:00.000Z";
  const edited = await client.recheck({ surface: name, attemptId: "trusted", payload, destinationId: "post-1" });
  assert.equal(edited.classification.verdict, "package_unverified");
  assert.equal(edited.observedAt, time);
  assert.equal(edited.independentlyVerified, true);
  assert.equal(edited.observedPackageDigest, digestPayload(currentPayload));
  assert.equal(client.claimComplete(original), "post-1");
  assert.throws(() => client.claimComplete(edited), VerificationPendingError);
  assert.equal(getReceipt("post-1", digestPayload(payload), store, { actionId: action.actionId })?.observedAt, original.observedAt);
  assert.equal(store.read().filter((entry) => entry.event === "recheck").length, 2);
  assert.equal(reads, 3);
});

test("connector timeout and wrong account fail closed without storing provider error details", async () => {
  for (const mode of ["timeout", "wrong-account"] as const) {
    const store = new TestStore();
    const name = surface();
    const secret = "private-token-and-response-body";
    const client = createReceipts({ store, connector: { surface: name, read() {
      if (mode === "timeout") throw new Error(secret);
      return { destinationId: "post-1", destinationAccount: "provider:wrong", packageDigest: digestPayload({ secret }), observedAt: new Date().toISOString() };
    } } });
    await client.execute({ ...identity(), surface: name, attemptId: mode, payload: { secret }, execute() { throw new Error(secret); } });
    const receipt = await client.reconcile({ surface: name, attemptId: mode, payload: { secret }, destinationId: "post-1" });
    assert.equal(receipt.classification.verdict, "delivery_unknown");
    assert.equal(receipt.independentlyVerified, false);
    assert.doesNotMatch(JSON.stringify(store.read()), new RegExp(secret));
  }
});

test("a connector audit failure propagates instead of returning a completion receipt", async () => {
  const store = new TestStore();
  const name = surface();
  const payload = { text: "approved" };
  const client = createReceipts({ store, connector: { surface: name, read() {
    store.failAppend = true;
    return { destinationId: "post-1", destinationAccount: "provider:account-1", packageDigest: digestPayload(payload), observedAt: new Date().toISOString() };
  } } });
  await client.execute({ ...identity(), surface: name, attemptId: "persist-fail", payload, execute() { throw new Error("lost"); } });
  await assert.rejects(client.reconcile({ surface: name, attemptId: "persist-fail", payload, destinationId: "post-1" }), /Audit unavailable/);
});

test("cooperative rechecks append current observations while preserving the original host-supplied receipt", async () => {
  const store = new TestStore();
  const payload = { text: "approved" };
  let current = payload;
  let observedAt = "2026-09-25T10:42:00.000Z";
  const name = surface((write) => ({ destinationId: "post-1", packageDigest: digestPayload(current), evidence: [{
    source: "provider" as const, detail: "cooperative read", destinationId: "post-1", packageDigest: digestPayload(current), observedAt,
  }] }));
  const client = createReceipts({ store });
  const action = identity();
  const original = await client.execute({ ...action, surface: name, attemptId: "coop-history", payload, execute() {} });
  assert.equal(original.observedAt, observedAt);
  const prefix = store.read();
  observedAt = "2026-09-25T11:05:00.000Z";
  const same = await client.recheck({ surface: name, attemptId: "coop-history", payload, destinationId: "post-1" });
  assert.equal(same.classification.verdict, "complete");
  assert.equal(same.observedAt, observedAt);
  assert.equal(client.claimComplete(same), "post-1");
  observedAt = "2026-09-25T12:00:00.000Z";
  current = { text: "edited" };
  const changed = await client.recheck({ surface: name, attemptId: "coop-history", payload, destinationId: "post-1" });
  assert.equal(changed.classification.verdict, "package_unverified");
  assert.equal(changed.observedAt, observedAt);
  assert.equal(changed.observedPackageDigest, digestPayload(current));
  assert.equal(changed.evidenceSource, "host-supplied");
  assert.equal(changed.independentlyVerified, false);
  assert.equal(client.claimComplete(original), "post-1");
  assert.deepEqual(store.read().slice(0, prefix.length), prefix);
  assert.equal(getReceipt("post-1", digestPayload(payload), store, { actionId: action.actionId })?.observedAt, original.observedAt);
});

test('policy denies before dispatch, names its rule, and leaves a recoverable unused action', async () => {
  const {MemoryAuditStore}=await import('@77systems/receipts-core');
  const {PolicyDeniedError}=await import('../src/index.js');
  const store=new MemoryAuditStore();let writes=0;
  const name=surface();const account='provider:blocked';
  const options={...identity(account),surface:name,attemptId:'blocked',payload:{private:'do-not-log'},execute(){writes++;}};
  const client=createReceipts({store,policy:{rules:[{id:'block-account',effect:'block',destinationAccount:account}]}});
  await assert.rejects(client.execute(options),(error:unknown)=>error instanceof PolicyDeniedError&&error.verdict==='policy_denied'&&error.ruleId==='block-account'&&Boolean(error.decision.auditEntryId));
  assert.equal(writes,0);assert.equal(store.read().filter(entry=>entry.event==='attempt').length,0);
  // Fail fast: a forbidden write is refused before any reservation exists, as one audited decision.
  assert.deepEqual(store.read().map(entry=>entry.event),['policy_denied']);
  assert.equal(store.read().find(entry=>entry.event==='policy_denied')?.admission?.ruleId,'block-account');
  assert.equal(store.read()[0]!.registry,undefined);
  // A deliberate policy correction can authorize the same never-dispatched approval.
  await createReceipts({store}).execute({...options,attemptId:'after-policy-correction'});
  assert.equal(writes,1);
});

test('policy budgets are shared across SDK clients; duplicate decisions are audited', async () => {
  const {MemoryAuditStore}=await import('@77systems/receipts-core');
  const {PolicyDeniedError}=await import('../src/index.js');
  const store=new MemoryAuditStore();let writes=0;const name=surface();
  const policy={rateLimits:[{id:'one-per-hour',surface:name,maxWrites:1,windowMs:3600000}]};
  const first={...identity(),surface:name,attemptId:'first-budget',payload:{text:'approved'},execute(){writes++;}};
  await createReceipts({store,policy}).execute(first);
  await assert.rejects(createReceipts({store,policy}).execute({...first,...identity(),attemptId:'second-budget'}),PolicyDeniedError);
  await assert.rejects(createReceipts({store,policy}).execute({...first,attemptId:'duplicate-budget'}),(error:unknown)=>error instanceof DuplicateWriteError&&error.verdict==='DUPLICATE'&&Boolean(error.decision?.auditEntryId));
  assert.equal(writes,1);assert.equal(store.read().filter(entry=>entry.event==='duplicate').length,1);
});

test('registry completion survives SDK restart after destination read-back', async () => {
  const {MemoryAuditStore}=await import('@77systems/receipts-core');
  const store=new MemoryAuditStore();const name=surface();const payload={text:'approved'};
  const options={...identity(),surface:name,attemptId:'restart',payload,execute(){throw new Error('lost');}};
  await createReceipts({store}).execute(options);
  const connector={surface:name,read:()=>({destinationAccount:options.destinationAccount,destinationId:'post-1',packageDigest:digestPayload(payload),observedAt:new Date().toISOString()})};
  const result=await createReceipts({store,connector}).reconcile({surface:name,attemptId:'restart',payload});
  assert.equal(result.classification.verdict,'complete');
  assert.equal(store.read().find(entry=>entry.event==='claim_completed')?.admission?.verdict,'COMPLETED');
  await assert.rejects(createReceipts({store}).execute({...options,attemptId:'after-complete'}),DuplicateWriteError);
  assert.ok(store.read().every(entry=>!('token' in (entry.registry??{}))));
});

test('a budget consumed between claim and dispatch is denied at dispatch and the unused reservation is released, freeing its approval',async()=>{
 const {MemoryAuditStore,createIdempotencyRegistry}=await import('@77systems/receipts-core');
 const {PolicyDeniedError}=await import('../src/index.js');
 const base=new MemoryAuditStore();const name=surface();
 const policy={rateLimits:[{id:'one-dispatch',maxWrites:1,windowMs:60_000,surface:name}]};
 const mine={...identity(),surface:name,attemptId:'raced-then-released'};
 let injected=false;
 const store:AuditStore={
  read(){
   const entries=base.read();
   if(!injected&&entries.some(entry=>entry.event==='claim'&&entry.actionId===mine.actionId)){
    injected=true;
    const competitor=createIdempotencyRegistry({store:base});
    const lease=competitor.claim({...mine,...identity(),attemptId:'competitor',packageDigest:digestPayload({other:true})},policy);
    if(lease.verdict!=='CLAIMED')throw new Error('competitor must claim');
    competitor.dispatch(lease.claim,policy);
    return base.read();
   }
   return entries;
  },
  append(entry,expectedLength){base.append(entry,expectedLength);},
 };
 let writes=0;
 await assert.rejects(createReceipts({store,policy}).execute({...mine,payload:{approved:true},execute(){writes++;}}),error=>error instanceof PolicyDeniedError&&error.ruleId==='one-dispatch');
 assert.equal(writes,0);
 assert.deepEqual(base.read().filter(entry=>entry.actionId===mine.actionId).map(entry=>entry.event),['claim','policy_denied','claim_released']);
 // The approval is free again: once the window passes, the same approval and action can proceed.
 const later=createIdempotencyRegistry({store:base,now:()=>Date.now()+61_000});
 const retry=later.claim({surface:name,attemptId:'after-window',actionId:mine.actionId,destinationAccount:mine.destinationAccount,approvalId:mine.approvalId,packageDigest:digestPayload({approved:true})},policy);
 assert.equal(retry.verdict,'CLAIMED');
 if(retry.verdict!=='CLAIMED')throw new Error('expected claim');
 assert.equal(later.dispatch(retry.claim,policy).verdict,'AUTHORIZED');
});

test('a budget consumed between claim and dispatch is denied at dispatch; a failed release keeps the named outcome',async()=>{
 const {MemoryAuditStore,ReceiptsError,createIdempotencyRegistry}=await import('@77systems/receipts-core');
 const {PolicyDeniedError}=await import('../src/index.js');
 const base=new MemoryAuditStore();const name=surface();
 const policy={rateLimits:[{id:'one-dispatch',maxWrites:1,windowMs:60_000,surface:name}]};
 const mine={...identity(),surface:name,attemptId:'raced-budget'};
 let injected=false;
 const store:AuditStore={
  read(){
   const entries=base.read();
   if(!injected&&entries.some(entry=>entry.event==='claim'&&entry.actionId===mine.actionId)){
    // Claim-time evaluation passed. Before our dispatch snapshot, a competitor takes the only budget slot.
    injected=true;
    const competitor=createIdempotencyRegistry({store:base});
    const lease=competitor.claim({...mine,...identity(),attemptId:'competitor',packageDigest:digestPayload({other:true})},policy);
    if(lease.verdict!=='CLAIMED')throw new Error('competitor must claim');
    if(competitor.dispatch(lease.claim,policy).verdict!=='AUTHORIZED')throw new Error('competitor must dispatch');
    return base.read();
   }
   return entries;
  },
  append(entry,expectedLength){base.append(entry,expectedLength);},
 };
 const client=createReceipts({store,policy});
 client.registry.release=()=>{throw new ReceiptsError('claim_expired','Reservation expired during cleanup.');};
 let writes=0;
 await assert.rejects(client.execute({...mine,payload:{approved:true},execute(){writes++;}}),error=>error instanceof PolicyDeniedError&&error.ruleId==='one-dispatch');
 assert.equal(writes,0);
 assert.ok(injected,'the race must actually occur');
 const events=base.read().filter(entry=>entry.actionId===mine.actionId).map(entry=>entry.event);
 assert.deepEqual(events,['claim','policy_denied'],'dispatch remains the enforcement boundary after a passing claim-time check');
 assert.equal(base.read().filter(entry=>entry.event==='attempt').length,1);
});

test('SDK refusals say what to do next: a reused approval asks for a separate approval per write', async () => {
  const {MemoryAuditStore}=await import('@77systems/receipts-core');
  const {PolicyDeniedError}=await import('../src/index.js');
  const store=new MemoryAuditStore();const name=surface();
  const first={...identity(),surface:name,attemptId:'first-approval-use',payload:{text:'one'},execute(){}};
  await createReceipts({store}).execute(first);
  await assert.rejects(createReceipts({store}).execute({...first,actionId:randomUUID(),attemptId:'second-approval-use',payload:{text:'two'}}),(error:unknown)=>
    error instanceof DuplicateWriteError&&error.decision?.reason==='approval_reused'&&/^Request a separate approval per write/.test(error.hint)&&/approval_reused/.test(error.message));
  await assert.rejects(createReceipts({store,policy:{defaultEffect:'block'}}).execute({...first,...identity(),attemptId:'blocked'}),(error:unknown)=>
    error instanceof PolicyDeniedError&&/Inspect ruleId/.test(error.hint)&&/default-policy/.test(error.message));
  assert.match(new VerificationPendingError().hint,/Reconcile/);
});
