import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bind, createAuditEntry, digestPackage, getReceipt, JsonlAuditStore, MemoryAuditStore,
  observeDestination, record, verify, type AuditEntry, type AuditStore, type ConnectorRequest,
  type DestinationConnector,
} from "../src/index.js";

const approved = digestPackage("approved private content");
const changed = digestPackage("edited content");
const request: ConnectorRequest = {
  surface: "social-publish", attemptId: "v02-attempt", actionId: "123e4567-e89b-42d3-a456-426614174000",
  destinationAccount: "social:account-1", approvalId: "approval-1", packageDigest: approved, destinationId: "post-1",
};
const observedAt = "2026-09-25T10:42:00.000Z";
const recheckedAt = "2026-09-25T11:05:00.000Z";
const code = (expected: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === expected;
function observation(): AuditEntry {
  return createAuditEntry({ ...request, evidence: [{ source: "provider", detail: "Host claims provider read",
    destinationId: request.destinationId, packageDigest: approved, observedAt }] }, "observation");
}
function connector(overrides = {}): DestinationConnector {
  return { surface: request.surface, read: () => ({ destinationAccount: request.destinationAccount,
    destinationId: request.destinationId!, packageDigest: approved, observedAt, ...overrides }) };
}

for (const backend of ["memory", "jsonl"] as const) {
  test(`${backend}: every supplemental binding reference is redacted through record and direct append`, (context) => {
    const directory = mkdtempSync(join(tmpdir(), "receipts-binding-privacy-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const direct of [false, true]) {
      const path = join(directory, `audit-${direct}.jsonl`);
      const store = backend === "memory" ? new MemoryAuditStore() : new JsonlAuditStore(path);
      const observed = observation();
      record(observed, store);
      const entry = createAuditEntry({ ...request, boundPackageDigest: approved, evidence: [
        { source: "binding", detail: "Approved binding", destinationId: request.destinationId,
          packageDigest: approved, reference: observed.id },
      ] }, "binding");
      entry.evidence.push({ source: "binding", detail: "SECRET_SUPPLEMENTAL_DESCRIPTION",
        destinationId: request.destinationId, packageDigest: approved, reference: "https://host/?token=SECRET_SUPPLEMENTAL_TOKEN" });
      if (direct) store.append(entry); else record(entry, store);
      const saved = store.read().at(-1)!;
      assert.equal(saved.verdict, "complete");
      assert.equal(saved.evidence[0]!.reference, observed.id);
      assert.equal(saved.evidence[1]!.reference, undefined);
      assert.equal(saved.evidence[1]!.referenceDigest, digestPackage("https://host/?token=SECRET_SUPPLEMENTAL_TOKEN"));
      assert.equal(saved.evidence[1]!.detailDigest, digestPackage("SECRET_SUPPLEMENTAL_DESCRIPTION"));
      assert.ok(!JSON.stringify(store.read()).includes("SECRET_"));
      if (backend === "jsonl") assert.ok(!readFileSync(path, "utf8").includes("SECRET_"));
    }
  });

  test(`${backend}: forged wire trust and direct append never become independent`, (context) => {
    const directory = mkdtempSync(join(tmpdir(), "receipts-v02-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const direct of [false, true]) {
      const store = backend === "memory" ? new MemoryAuditStore() : new JsonlAuditStore(join(directory, `audit-${direct}.jsonl`));
      const forged = { ...observation(), evidenceSource: "receipts-read", independentlyVerified: true } as AuditEntry;
      if (direct) store.append(forged); else record(forged, store);
      const receipt = bind(request.destinationId!, approved, store);
      assert.equal(receipt.evidenceSource, "host-supplied");
      assert.equal(receipt.independentlyVerified, false);
      assert.equal(getReceipt(request.destinationId!, approved, store)?.independentlyVerified, false);
      assert.ok(store.read().every((entry) => !entry.independentlyVerified));
    }
  });

  test(`${backend}: connector executes read itself and binds full scoped provenance`, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "receipts-v02-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "audit.jsonl");
    const store = backend === "memory" ? new MemoryAuditStore() : new JsonlAuditStore(path);
    let reads = 0;
    const reader = connector();
    const receipt = await observeDestination({ surface: request.surface, read: async (input) => { reads++; return reader.read(input); } }, request, store);
    assert.equal(reads, 1);
    assert.equal(receipt.verdict, "complete");
    for (const key of ["actionId", "destinationAccount", "approvalId", "destinationId", "packageDigest"] as const) assert.equal(receipt[key], request[key]);
    assert.equal(receipt.evidenceSource, "receipts-read");
    assert.equal(receipt.independentlyVerified, true);
    assert.equal(receipt.observedAt, observedAt);
    assert.equal(store.read()[0]!.id, receipt.observationId);
    assert.equal(store.read()[1]!.id, receipt.auditEntryId);
    if (backend === "jsonl") assert.deepEqual(getReceipt(request.destinationId!, approved, new JsonlAuditStore(path)), receipt);
  });

  test(`${backend}: edit after verification appends a current result, preserving the old receipt`, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), "receipts-v02-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = backend === "memory" ? new MemoryAuditStore() : new JsonlAuditStore(join(directory, "audit.jsonl"));
    const original = await observeDestination(connector(), request, store);
    const oldEntries = store.read();
    const current = await observeDestination(connector({ packageDigest: changed, observedAt: recheckedAt }), { ...request, recheck: true }, store);
    assert.equal(current.verdict, "package_unverified");
    assert.equal(current.observedPackageDigest, changed);
    assert.equal(current.observedAt, recheckedAt);
    assert.equal(current.independentlyVerified, true);
    assert.equal(store.read().length, oldEntries.length + 1);
    assert.deepEqual(store.read().slice(0, oldEntries.length), oldEntries);
    assert.deepEqual(getReceipt(request.destinationId!, approved, store), original);
    assert.equal(verify(request.destinationId!, approved, store), "complete", "Historical verification does not assert current content.");
    const correctAgain = await observeDestination(connector({ observedAt: "2026-09-25T12:00:00.000Z" }), { ...request, recheck: true }, store);
    assert.equal(correctAgain.verdict, "complete");
    assert.equal(store.read().at(-1)!.verdict, "complete");
    assert.equal(correctAgain.auditEntryId, store.read().at(-1)!.id);
    assert.deepEqual(getReceipt(request.destinationId!, approved, store), original);
  });
}

test("trusted read can add independent proof after a cooperative receipt without refreshing the old receipt", async () => {
  const store = new MemoryAuditStore();
  record(observation(), store);
  const hostReceipt = bind(request.destinationId!, approved, store);
  const readReceipt = await observeDestination(connector({ observedAt: recheckedAt }), request, store);
  assert.equal(hostReceipt.independentlyVerified, false);
  assert.equal(readReceipt.independentlyVerified, true);
  assert.notEqual(readReceipt.auditEntryId, hostReceipt.auditEntryId);
  assert.equal(getReceipt(request.destinationId!, approved, store)?.auditEntryId, hostReceipt.auditEntryId);
});

test("connector rejects wrong account, wrong object, invalid digest, and failed reads without issuing proof", async () => {
  const store = new MemoryAuditStore();
  await assert.rejects(observeDestination(connector({ destinationAccount: "other-account" }), request, store), code("account_mismatch"));
  await assert.rejects(observeDestination(connector({ destinationId: "other-object" }), request, store), code("object_mismatch"));
  await assert.rejects(observeDestination(connector({ packageDigest: "not-a-digest" }), request, store), code("invalid_digest"));
  await assert.rejects(observeDestination(connector({ observedAt: "not-time" }), request, store), code("invalid_observation"));
  await assert.rejects(observeDestination({ surface: request.surface, read: () => { throw Error("SECRET provider error"); } }, request, store), code("connector_read_failed"));
  assert.equal(store.read().length, 0);
});

test("store failures propagate after a connector read", async () => {
  const store: AuditStore = { read: () => [], append: () => { throw Error("disk full"); } };
  await assert.rejects(observeDestination(connector(), request, store), /disk full/);
});

test("changed content cannot create initial completion", async () => {
  const store = new MemoryAuditStore();
  const receipt = await observeDestination(connector({ packageDigest: changed }), request, store);
  assert.equal(receipt.verdict, "package_unverified");
  assert.equal(receipt.observedPackageDigest, changed);
  assert.equal(getReceipt(request.destinationId!, approved, store), undefined);
  assert.throws(() => bind(request.destinationId!, approved, store), code("observation_required"));
});

test("account collisions need explicit scope, and exact scopes do not cross-verify", async () => {
  const store = new MemoryAuditStore();
  const first = await observeDestination(connector(), request, store);
  const otherRequest = { ...request, attemptId: "other-attempt", actionId: randomUUID(), destinationAccount: "social:account-2", approvalId: "approval-2" };
  const second = await observeDestination(connector({ destinationAccount: otherRequest.destinationAccount }), otherRequest, store);
  assert.throws(() => getReceipt(request.destinationId!, approved, store), code("ambiguous_destination"));
  assert.deepEqual(getReceipt(request.destinationId!, approved, store, request), first);
  assert.deepEqual(getReceipt(request.destinationId!, approved, store, otherRequest), second);
  assert.equal(verify(request.destinationId!, approved, store, { destinationAccount: "unknown" }), "prewrite");
});

test("new entries require action identity and attempts cannot change account or approval", () => {
  const { actionId, ...withoutAction } = request;
  assert.throws(() => createAuditEntry(withoutAction), code("action_identity_required"));
  assert.throws(() => createAuditEntry({ ...request, actionId: "not-a-uuid" }), code("invalid_action_id"));
  const store = new MemoryAuditStore();
  record(observation(), store);
  assert.throws(() => record(createAuditEntry({ ...request, destinationAccount: "other" }), store), code("invalid_entry"));
  assert.throws(() => record(createAuditEntry({ ...request, approvalId: "other" }), store), code("invalid_entry"));
});

test("same action uncertain retry is blocked at append, new action with same digest is allowed", () => {
  const store = new MemoryAuditStore();
  const claim = { ...request, destinationId: undefined, writeMayHaveHappened: true };
  record(createAuditEntry(claim, "attempt"), store);
  assert.throws(() => record(createAuditEntry({ ...claim, attemptId: "repeat" }, "attempt"), store), code("duplicate_attempt"));
  assert.throws(() => record(createAuditEntry({ ...claim, actionId: claim.actionId.toUpperCase(), attemptId: "repeat-capitals" }, "attempt"), store), code("duplicate_attempt"));
  record(createAuditEntry({ ...claim, attemptId: "new-approved", actionId: randomUUID(), approvalId: "new-approval" }, "attempt"), store);
  assert.equal(store.read().length, 2);
});

test("audit allowlist keeps payload, credentials, descriptions, and provider URLs off disk", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-privacy-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.jsonl");
  const store = new JsonlAuditStore(path);
  const entry = observation() as AuditEntry & { payload: unknown; credentials: string };
  entry.payload = { title: "SECRET_PAYLOAD" };
  entry.credentials = "SECRET_TOKEN";
  entry.statusFlag = "SECRET_STATUS";
  entry.evidence[0] = { source: "provider", detail: "SECRET_DESCRIPTION", reference: "https://host/?token=SECRET_URL",
    destinationId: request.destinationId, packageDigest: approved, observedAt };
  Object.assign(entry.evidence[0], { body: "SECRET_BODY", token: "SECRET_EVIDENCE_TOKEN" });
  record(entry, store);
  const text = readFileSync(path, "utf8");
  assert.ok(!text.includes("SECRET_"));
  assert.equal(store.read()[0]!.evidence[0]!.detailDigest, digestPackage("SECRET_DESCRIPTION"));
  assert.equal(store.read()[0]!.evidence[0]!.referenceDigest, digestPackage("https://host/?token=SECRET_URL"));
});

test("v0.1 hash chains remain readable without rewriting hashes and are cooperative", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-legacy-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.jsonl");
  const old = observation();
  for (const key of ["actionId", "destinationAccount", "approvalId", "evidenceSource", "independentlyVerified", "observedAt", "observedPackageDigest"] as const) delete old[key];
  const bound = { ...old, id: randomUUID(), event: "binding", verdict: "complete", boundPackageDigest: approved,
    evidence: [{ source: "binding", detail: "Legacy binding", destinationId: request.destinationId, packageDigest: approved, reference: old.id }] };
  const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const envelopes: { hash: string }[] = [];
  for (const entry of [old, bound]) {
    const payload = { version: 1, sequence: envelopes.length + 1, previousHash: envelopes.at(-1)?.hash ?? null, entry };
    envelopes.push({ ...payload, hash: createHash("sha256").update(stable(payload)).digest("hex") });
  }
  const text = envelopes.map(stable).join("\n") + "\n";
  writeFileSync(path, text);
  writeFileSync(`${path}.head`, JSON.stringify({ count: envelopes.length, hash: envelopes.at(-1)!.hash }));
  const store = new JsonlAuditStore(path);
  assert.equal(verify(request.destinationId!, approved, store), "complete");
  assert.equal(getReceipt(request.destinationId!, approved, store)?.independentlyVerified, false);
  assert.equal(getReceipt(request.destinationId!, approved, store)?.evidenceSource, "host-supplied");
  assert.equal(readFileSync(path, "utf8"), text);
});
