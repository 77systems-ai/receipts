import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertComplete, bind, classify, createAuditEntry, digestPackage, getSurface,
  JsonlAuditStore, listSurfaces, mayRearmPrewrite, MemoryAuditStore, record,
  registerSurface, verify, type AuditEntry, type AuditStore, type OutwardWrite,
} from "../src/index.js";

const approved = digestPackage("approved content");
const different = digestPackage("different content");
const base: OutwardWrite = { surface: "social-publish", attemptId: "attempt-1", packageDigest: approved,
  actionId: "123e4567-e89b-42d3-a456-426614174000", destinationAccount: "social:account-1", approvalId: "approval-1" };

function errorCode(code: string) {
  return (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function observation(overrides: Partial<OutwardWrite> = {}): AuditEntry {
  const write = { ...base, destinationId: "post-123", publicObjectExists: true, ...overrides };
  return createAuditEntry({ ...write, evidence: [{ source: "provider", detail: "Read back exact published payload.",
    destinationId: write.destinationId, packageDigest: write.packageDigest }] }, "observation");
}

test("all four verdicts and the entire permission matrix", () => {
  const cases: [Partial<OutwardWrite>, string, boolean][] = [
    [{ neverReached: true }, "prewrite", false],
    [{ neverReached: true, rearm: { causeFixed: true, previousDigest: different, previousAttemptId: "older" } }, "prewrite", true],
    [{ writeMayHaveHappened: true }, "delivery_unknown", false],
    [{ destinationId: "post-123" }, "package_unverified", false],
    [{ publicObjectExists: true }, "package_unverified", false],
    [{ destinationId: "post-123", boundPackageDigest: approved }, "complete", false],
  ];
  for (const [input, verdict, mayRearm] of cases) {
    const result = classify({ ...base, ...input });
    assert.equal(result.verdict, verdict);
    assert.equal(result.mayAutoRetry, false);
    assert.equal(result.maySecondWrite, false);
    assert.equal(result.mayRearm, mayRearm);
  }
});

test("precedence: complete, uncertainty, placement, then prewrite", () => {
  for (const destinationId of [undefined, "post-123"]) {
    for (const boundPackageDigest of [undefined, approved, different]) {
      for (const writeMayHaveHappened of [false, true]) {
        for (const publicObjectExists of [false, true]) {
          const result = classify({ ...base, destinationId, boundPackageDigest, writeMayHaveHappened, publicObjectExists,
            neverReached: true, rearm: { causeFixed: true, previousDigest: different, previousAttemptId: "older" } });
          const expected = destinationId && boundPackageDigest === approved ? "complete"
            : writeMayHaveHappened ? "delivery_unknown" : destinationId || publicObjectExists ? "package_unverified" : "prewrite";
          assert.equal(result.verdict, expected);
          assert.equal(result.mayAutoRetry, false);
          assert.equal(result.maySecondWrite, false);
          assert.equal(result.mayRearm, expected === "prewrite");
        }
      }
    }
  }
});

test("status flags and placement URLs do not establish completion", () => {
  for (const statusFlag of ["sent", "published", "verified", "completed"]) {
    assert.equal(classify({ ...base, statusFlag }).verdict, "prewrite");
    assert.equal(classify({ ...base, statusFlag, publicObjectExists: true }).verdict, "package_unverified");
  }
  assert.throws(() => classify({ ...base, destinationId: "https://example.com/posts/123", boundPackageDigest: approved }), errorCode("invalid_destination_id"));
  assert.equal(classify({ ...base, destinationId: "post-123", boundPackageDigest: different }).verdict, "package_unverified");
});

test("rearming refuses missing cause fixes, unchanged digests, unchanged attempts, and uncertain writes", () => {
  const write: OutwardWrite = { ...base, neverReached: true,
    rearm: { causeFixed: true, previousDigest: different, previousAttemptId: "older" } };
  assert.equal(mayRearmPrewrite(write), true);
  assert.equal(mayRearmPrewrite({ ...write, neverReached: undefined }), false);
  assert.equal(mayRearmPrewrite({ ...write, neverReached: false }), false);
  assert.equal(mayRearmPrewrite({ ...write, rearm: undefined }), false);
  assert.equal(mayRearmPrewrite({ ...write, rearm: { ...write.rearm!, causeFixed: false } }), false);
  assert.equal(mayRearmPrewrite({ ...write, rearm: { ...write.rearm!, previousDigest: approved } }), false);
  assert.equal(mayRearmPrewrite({ ...write, rearm: { ...write.rearm!, previousAttemptId: base.attemptId } }), false);
  assert.equal(mayRearmPrewrite({ ...write, writeMayHaveHappened: true }), false);
  assert.equal(mayRearmPrewrite({ ...write, destinationId: "post-123" }), false);
});

test("unknown surfaces are rejected instead of adding a fifth verdict", () => {
  for (const surface of ["unknown", "like", "heartbeat", "ad-spend"]) {
    assert.throws(() => classify({ ...base, surface }), errorCode("not_a_destination_write"));
  }
  assert.deepEqual(listSurfaces().slice(0, 4), ["http-post", "social-publish", "email-send", "file-write"]);
});

test("surface registration is closed, pattern-validated, and classify never invokes observe", () => {
  let observations = 0;
  registerSurface({ name: "test-receipt-lane", idPattern: /^lane:\d+$/g,
    observe: () => { observations++; throw new Error("Classifier must not observe."); } });
  const write = Object.freeze({ ...base, surface: "test-receipt-lane", destinationId: "lane:123", boundPackageDigest: approved });
  assert.equal(classify(write).verdict, "complete");
  assert.equal(classify(write).verdict, "complete");
  assert.equal(observations, 0);
  assert.throws(() => classify({ ...write, destinationId: "wrong:123" }), errorCode("invalid_destination_id"));
  getSurface("test-receipt-lane").idPattern.compile(".*");
  assert.throws(() => classify({ ...write, destinationId: "wrong:123" }), errorCode("invalid_destination_id"));
  assert.throws(() => registerSurface({ name: "test-receipt-lane", idPattern: /.*/ }), errorCode("surface_already_registered"));
});

test("package identities are real SHA-256 digests of exact bytes", () => {
  assert.equal(digestPackage("abc"), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(digestPackage(new TextEncoder().encode("abc")), digestPackage("abc"));
  assert.notEqual(digestPackage("abc "), digestPackage("abc"));
  for (const packageDigest of ["approved", "", "sha256:123", "A".repeat(64)]) {
    assert.throws(() => classify({ ...base, packageDigest }), errorCode("invalid_digest"));
  }
});

test("uncertain write resolves through observation and binding without a second write", () => {
  const store = new MemoryAuditStore();
  const uncertain = createAuditEntry({ ...base, writeMayHaveHappened: true,
    evidence: [{ source: "executor", detail: "Transport timed out after dispatch." }] }, "attempt");
  record(uncertain, store);
  assert.equal(classify(uncertain).mayAutoRetry, false);
  assert.equal(classify(uncertain).maySecondWrite, false);
  assert.equal(verify("post-123", approved, store), "delivery_unknown");
  assert.throws(() => assertComplete("post-123", approved, store), errorCode("not_complete"));
  record(observation(), store);
  assert.equal(verify("post-123", approved, store), "package_unverified");
  const binding = bind("post-123", approved, store);
  assert.equal(binding.observationId, store.read()[1]!.id);
  assert.equal(binding.attemptId, base.attemptId);
  assert.equal(verify("post-123", approved, store), "complete");
  assert.doesNotThrow(() => assertComplete("post-123", approved, store));
  assert.equal(store.read().filter((entry) => entry.event === "attempt").length, 1);
  assert.equal(store.read().length, 3);
  assert.deepEqual(bind("post-123", approved, store), binding);
  assert.equal(store.read().length, 3, "Rebinding must not duplicate the binding entry.");
});

test("human-supplied evidence can bind only an audited object and exact digest", () => {
  const store = new MemoryAuditStore();
  const entry = observation();
  entry.evidence[0]!.source = "human";
  record(entry, store);
  assert.equal(bind("post-123", approved, store).destinationId, "post-123");
  assert.throws(() => bind("invented-post", approved, store), errorCode("observation_required"));
  assert.throws(() => bind("post-123", different, store), errorCode("observation_required"));
  assert.equal(verify("post-123", different, store), "package_unverified");
});

test("unmatched read-back digest cannot become a binding", () => {
  const store = new MemoryAuditStore();
  const entry = observation();
  entry.evidence[0]!.packageDigest = different;
  record(entry, store);
  assert.throws(() => bind("post-123", approved, store), errorCode("observation_required"));
  assert.equal(verify("post-123", approved, store), "package_unverified");
});

test("record refuses invented completion and inconsistent evidence", () => {
  const store = new MemoryAuditStore();
  const completed = createAuditEntry({ ...base, destinationId: "post-123", boundPackageDigest: approved });
  assert.throws(() => record(completed, store), errorCode("observation_required"));
  const entry = createAuditEntry(base);
  assert.throws(() => record({ ...entry, verdict: "complete" }, store), errorCode("invalid_entry"));
  assert.throws(() => record({ ...entry, evidence: [] }, store), errorCode("invalid_entry"));
  assert.throws(() => record({ ...observation(), evidence: [{ source: "executor", detail: "POST returned success." }] }, store), errorCode("invalid_entry"));
  assert.equal(store.read().length, 0);
});

test("complete classifications can be recorded after an audited binding", () => {
  const store = new MemoryAuditStore();
  record(observation(), store);
  bind("post-123", approved, store);
  const entry = createAuditEntry({ ...base, destinationId: "post-123", boundPackageDigest: approved });
  record(entry, store);
  assert.equal(store.read().length, 3);
  assert.doesNotThrow(() => assertComplete(classify(entry)));
});

test("same object spelling cannot bind across ambiguous surfaces", () => {
  const store = new MemoryAuditStore();
  record(observation(), store);
  record(observation({ surface: "http-post", attemptId: "other-attempt" }), store);
  assert.throws(() => bind("post-123", approved, store), errorCode("ambiguous_destination"));
  assert.throws(() => verify("post-123", approved, store), errorCode("ambiguous_destination"));
});

test("one observed object and digest cannot be credited to a second attempt", () => {
  const store = new MemoryAuditStore();
  record(observation(), store);
  assert.throws(() => record(observation({ attemptId: "second-attempt" }), store), errorCode("ambiguous_destination"));
  assert.equal(store.read().length, 1);
  assert.equal(bind("post-123", approved, store).attemptId, base.attemptId);
  const contaminated: AuditStore = {
    read: () => [observation(), observation({ attemptId: "second-attempt" })],
    append: () => { throw new Error("An ambiguous history must never be appended to."); },
  };
  assert.throws(() => bind("post-123", approved, contaminated), errorCode("ambiguous_destination"));
  assert.throws(() => verify("post-123", approved, contaminated), errorCode("ambiguous_destination"));
});

test("an attempt cannot swap payload, destination lane, or object ID", () => {
  const store = new MemoryAuditStore();
  record(observation(), store);
  assert.throws(() => record(observation({ packageDigest: different }), store), errorCode("invalid_entry"));
  assert.throws(() => record(observation({ surface: "http-post" }), store), errorCode("invalid_entry"));
  assert.throws(() => record(observation({ destinationId: "post-456" }), store), errorCode("invalid_entry"));
});

test("an audited rearm must reference a real prewrite attempt and its prior digest", () => {
  const store = new MemoryAuditStore();
  const rearmed = createAuditEntry({ ...base, neverReached: true,
    rearm: { causeFixed: true, previousDigest: different, previousAttemptId: "previous-attempt" } });
  assert.throws(() => record(rearmed, store), errorCode("invalid_rearm"));
  record(createAuditEntry({ ...base, attemptId: "previous-attempt", packageDigest: different, neverReached: true }), store);
  record(rearmed, store);
  assert.equal(store.read().length, 2);
  const uncertainStore = new MemoryAuditStore();
  record(createAuditEntry({ ...base, attemptId: "previous-attempt", packageDigest: different, writeMayHaveHappened: true }), uncertainStore);
  assert.throws(() => record(rearmed, uncertainStore), errorCode("invalid_rearm"));
});

for (const backend of ["memory", "jsonl"] as const) {
  test(`${backend}: append-only entries are detached and CAS refuses stale claims`, (context) => {
    const directory = mkdtempSync(join(tmpdir(), "receipts-core-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const store: AuditStore = backend === "memory" ? new MemoryAuditStore() : new JsonlAuditStore(join(directory, "audit.jsonl"));
    const first = createAuditEntry({ ...base, writeMayHaveHappened: true }, "attempt");
    const original = JSON.parse(JSON.stringify(first));
    record(first, store, 0);
    first.evidence[0]!.detail = "Caller mutation";
    const read = store.read();
    read[0]!.evidence[0]!.detail = "Reader mutation";
    assert.deepEqual(store.read()[0], original);
    assert.throws(() => record(createAuditEntry({ ...base, attemptId: "attempt-2" }), store, 0), errorCode("audit_conflict"));
    assert.throws(() => record(original, store), errorCode("duplicate_entry"));
    record(observation(), store, 1);
    assert.deepEqual(store.read()[0], original);
    assert.equal(store.read().length, 2);
  });
}

test("JSONL hashes each entry and validates the full chain after restart", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-core-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.jsonl");
  const store = new JsonlAuditStore(path);
  record(observation(), store);
  bind("post-123", approved, store);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].previousHash, null);
  assert.equal(lines[1].previousHash, lines[0].hash);
  assert.equal(lines[0].hash.length, 64);
  assert.equal(verify("post-123", approved, new JsonlAuditStore(path)), "complete");
  lines[0].entry.evidence[0].detail = "tampered";
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.throws(() => store.read(), errorCode("audit_corrupt"));
  assert.throws(() => record(createAuditEntry(base), store), errorCode("audit_corrupt"));
});

test("JSONL fails closed on tail truncation, missing log, and partial entry", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-core-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.jsonl");
  const store = new JsonlAuditStore(path);
  record(observation(), store);
  bind("post-123", approved, store);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.split("\n")[0] + "\n");
  assert.throws(() => store.read(), errorCode("audit_corrupt"));
  writeFileSync(path, original.slice(0, -2));
  assert.throws(() => store.read(), errorCode("audit_corrupt"));
  rmSync(path);
  assert.throws(() => store.read(), errorCode("audit_corrupt"));
});

test("JSONL lock contention never falls back to an unsafe append", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "receipts-core-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "audit.jsonl");
  const store = new JsonlAuditStore(path);
  record(observation(), store);
  const before = readFileSync(path, "utf8");
  writeFileSync(`${path}.lock`, "held by another process");
  assert.throws(() => store.read(), errorCode("audit_locked"));
  assert.throws(() => store.append(createAuditEntry(base)), errorCode("audit_locked"));
  assert.equal(readFileSync(path, "utf8"), before);
});

test("async backends are refused before append", () => {
  let called = false;
  const store = { read: () => [], append: async () => { called = true; } } as unknown as AuditStore;
  assert.throws(() => record(createAuditEntry(base), store), errorCode("invalid_store"));
  assert.equal(called, false);
});
