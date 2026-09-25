import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlAuditStore, registerSurface } from "@77systems/receipts-core";
import { createReceipts, digestPayload, DuplicateWriteError, VerificationPendingError } from "@77systems/receipts-sdk";

// Offline destination and proposed Grok tool payload. No model or provider is
// called, and no secret is required. Replace only these adapter functions in
// your own bot; keep the executor/receipt gate in the actual tool code path.
const approvedPayload = { account: "demo-account", action: "announcement-001", text: "Hello from a verified agent." };
type Post = { id: string; payload: typeof approvedPayload };
let destinationPost: Post | null = null;
let writes = 0;

registerSurface({
  name: "grok-demo-post",
  idPattern: /^demo-post-[0-9]+$/,
  observe(write) {
    if (!destinationPost) throw new Error("Destination object unavailable");
    if (destinationPost.payload.account !== approvedPayload.account) throw new Error("Wrong account");
    const observedDigest = digestPayload(destinationPost.payload);
    if (observedDigest !== write.packageDigest) throw new Error("Approved payload does not match destination");
    return {
      destinationId: destinationPost.id,
      packageDigest: observedDigest,
      evidence: [{
        source: "provider", detail: "Offline fixture read-back of exact account and approved payload",
        destinationId: destinationPost.id, packageDigest: observedDigest,
      }],
    };
  },
});

// Each demo run gets its own append-only file, so runs are repeatable without
// deleting or resetting prior evidence. Files remain available for inspection.
const auditPath = join(mkdtempSync(join(tmpdir(), "receipts-grok-demo-")), "audit.jsonl");
const store = new JsonlAuditStore(auditPath);
const receipts = createReceipts({ store });
const request = {
  surface: "grok-demo-post",
  attemptId: "demo-attempt-001",
  actionId: randomUUID(),
  destinationAccount: "demo:demo-account",
  approvalId: "demo-approval-001",
  idempotencyKey: "demo-account:announcement-001",
  payload: approvedPayload,
  execute({ payload }: { payload: Readonly<typeof approvedPayload> }) {
    writes += 1;
    destinationPost = { id: "demo-post-001", payload: { ...payload } };
    throw new Error("Simulated connection loss after the destination accepted the post");
  },
};

const uncertain = await receipts.execute(request);
assert.equal(uncertain.classification.verdict, "delivery_unknown");
assert.equal(uncertain.classification.mayAutoRetry, false);
assert.equal(uncertain.classification.maySecondWrite, false);
assert.throws(() => receipts.claimComplete(uncertain), VerificationPendingError);
console.log("1. Connection lost: delivery_unknown. Bot refuses to claim posted.");

await assert.rejects(receipts.execute(request), DuplicateWriteError);
assert.equal(writes, 1);
console.log("2. Second execution refused. Destination writes: 1.");

const reconciled = await receipts.reconcile({
  surface: request.surface,
  attemptId: request.attemptId,
  payload: approvedPayload,
});
const destinationId = receipts.claimComplete(reconciled);
assert.equal(reconciled.classification.verdict, "complete");
assert.equal(destinationId, "demo-post-001");
assert.equal(reconciled.evidenceSource, "host-supplied");
assert.equal(reconciled.independentlyVerified, false);
assert.ok(reconciled.observedAt);
assert.equal(writes, 1);
assert.deepEqual(store.read().map((entry) => entry.event), ["attempt", "classification", "observation", "binding", "classification"]);
console.log("3. Cooperative fixture read-back bound the approved payload; evidenceSource: host-supplied, independentlyVerified: false.");
console.log(`4. Bot may now say: Posted in the offline fixture. Receipt: ${destinationId}. Observed at ${reconciled.observedAt}. No duplicate was created.`);
console.log(`Append-only audit: ${auditPath}`);
