import { randomUUID, createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { classify, digestPackage, validateDigest, validateEvidence } from "./classify.js";
import {
  ReceiptsError, type AuditEntry, type AuditEvent, type AuditStore, type Binding,
  type Classification, type OutwardWrite, type Verdict, type Receipt, type ReceiptScope,
  type ConnectorRequest, type DestinationConnector,
  type AuditEnvelope, type AuditChain,
} from "./types.js";

/** Stable JSON serialization for hashing; unsupported values fail closed. */
function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value)) throw new ReceiptsError("invalid_entry", "Audit values must be acyclic JSON data.");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new ReceiptsError("invalid_entry", "Audit values must be plain JSON objects.");
  }
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  else result = `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], seen)}`).join(",")}}`;
  seen.delete(value);
  return result;
}

function detached<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function invalid(message: string): never {
  throw new ReceiptsError("invalid_entry", message);
}

// This capability is intentionally object identity, never a serializable flag.
const connectorEntries = new WeakSet<object>();
const admissionEntries = new WeakSet<object>();
const admissionEvents = new Set<AuditEvent>(["claim", "claim_expired", "claim_released", "claim_completed", "policy_denied", "duplicate"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const summaries = {
  provider: "Destination evidence supplied by the host.",
  human: "Destination evidence supplied by the host.",
  executor: "Execution evidence supplied by the host.",
  binding: "Bound an audited destination observation to the approved package digest.",
} as const;

function requireAction(write: OutwardWrite): void {
  if (!write.actionId || !write.destinationAccount || !write.approvalId) {
    throw new ReceiptsError("action_identity_required", "New audit entries require actionId, destinationAccount, and approvalId.");
  }
  classify(write);
}

function inScope(entry: AuditEntry, scope?: ReceiptScope): boolean {
  return !scope || (["destinationAccount", "actionId", "surface", "attemptId"] as const)
    .every((key) => scope[key] === undefined || (key === "actionId"
      ? entry.actionId?.toLowerCase() === scope.actionId?.toLowerCase() : entry[key] === scope[key]));
}

function sameScope(a: OutwardWrite, b: OutwardWrite): boolean {
  return a.surface === b.surface && a.destinationAccount === b.destinationAccount && a.actionId?.toLowerCase() === b.actionId?.toLowerCase();
}

function timestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid("A valid timestamp is required.");
  return new Date(value).toISOString();
}

function matchesObservation(entry: AuditEntry, destinationId: string, digest: string): boolean {
  return (entry.event === "observation" || entry.event === "recheck") && entry.destinationId === destinationId
    && entry.packageDigest === digest && entry.evidence.some((evidence) =>
      (evidence.source === "provider" || evidence.source === "human")
      && evidence.destinationId === destinationId && evidence.packageDigest === digest);
}

/** Strict storage allowlist: descriptions and external references are digested, never persisted. */
function normalizedEntry(input: AuditEntry, previous: readonly AuditEntry[], trustedRead = false, trustedAdmission = false): AuditEntry {
  requireAction(input);
  if ((input.registry || input.admission || admissionEvents.has(input.event)) && !trustedAdmission) {
    throw new ReceiptsError("protected_admission", "Claim and policy state can only be changed through the idempotency registry.");
  }
  if (typeof input.id !== "string" || !uuidPattern.test(input.id)) {
    invalid("New audit entry IDs must be UUIDs.");
  }
  const entry: AuditEntry = {
    id: input.id, timestamp: timestamp(input.timestamp), event: input.event, verdict: input.verdict,
    surface: input.surface, attemptId: input.attemptId, actionId: input.actionId,
    destinationAccount: input.destinationAccount, approvalId: input.approvalId,
    packageDigest: input.packageDigest,
    evidenceSource: trustedRead ? "receipts-read" : "host-supplied", independentlyVerified: trustedRead,
    evidence: input.evidence.map((item) => ({
      source: item.source, detail: summaries[item.source],
      ...(item.detailDigest ? { detailDigest: item.detailDigest } : item.detail !== summaries[item.source] ? { detailDigest: digestPackage(item.detail) } : {}),
      ...(item.destinationId !== undefined ? { destinationId: item.destinationId } : {}),
      ...(item.packageDigest !== undefined ? { packageDigest: item.packageDigest } : {}),
      ...(item.observedAt !== undefined ? { observedAt: timestamp(item.observedAt) } : {}),
      ...(input.event === "binding" && item.source === "binding" && item.reference && uuidPattern.test(item.reference) ? { reference: item.reference }
        : item.referenceDigest ? { referenceDigest: item.referenceDigest }
        : item.reference ? { referenceDigest: digestPackage(item.reference) } : {}),
    })),
  };
  for (const key of ["destinationId", "boundPackageDigest", "idempotencyKey", "neverReached", "writeMayHaveHappened", "publicObjectExists"] as const) {
    if (input[key] !== undefined) Object.assign(entry, { [key]: input[key] });
  }
  if (input.rearm) entry.rearm = { causeFixed: input.rearm.causeFixed, previousDigest: input.rearm.previousDigest, previousAttemptId: input.rearm.previousAttemptId };
  if (input.registry) entry.registry = { leaseId: input.registry.leaseId, tokenHash: input.registry.tokenHash,
    fence: input.registry.fence, expiresAt: timestamp(input.registry.expiresAt) };
  if (input.admission) entry.admission = { verdict: input.admission.verdict,
    ...(input.admission.ruleId !== undefined ? { ruleId: input.admission.ruleId } : {}),
    ...(input.admission.reason !== undefined ? { reason: input.admission.reason } : {}) };
  const observedEvidence = input.evidence.find((item) => (item.source === "provider" || item.source === "human")
    && item.destinationId === input.destinationId);
  if (input.event === "observation" || input.event === "recheck" || observedEvidence) {
    entry.observedAt = timestamp(observedEvidence?.observedAt ?? input.timestamp);
    entry.observedPackageDigest = observedEvidence?.packageDigest;
  }
  if (input.event === "binding") {
    const reference = input.evidence.find((item) => item.source === "binding"
      && item.destinationId === input.destinationId && item.packageDigest === input.packageDigest)?.reference;
    if (reference !== undefined && !uuidPattern.test(reference)) {
      invalid("A binding reference must be an audit entry UUID.");
    }
    const observation = previous.find((item) => item.id === reference);
    if (observation) {
      entry.evidenceSource = observation.evidenceSource === "receipts-read" ? "receipts-read" : "host-supplied";
      entry.independentlyVerified = entry.evidenceSource === "receipts-read";
      entry.observedAt = observation.observedAt ?? observation.timestamp;
      entry.observedPackageDigest = observation.observedPackageDigest ?? observation.packageDigest;
    }
  }
  return detached(entry);
}

function validateAdmissionEntry(entry: AuditEntry, previous: readonly AuditEntry[]): void {
  if (!entry.admission && !entry.registry && !admissionEvents.has(entry.event)) return;
  const verdicts: Partial<Record<AuditEvent, string>> = { claim: "CLAIMED", attempt: "AUTHORIZED", claim_expired: "EXPIRED",
    claim_released: "RELEASED", claim_completed: "COMPLETED", policy_denied: "policy_denied", duplicate: "DUPLICATE" };
  if (!entry.admission || verdicts[entry.event] !== entry.admission.verdict) invalid("Admission verdict contradicts its event.");
  if (entry.admission.ruleId !== undefined && (typeof entry.admission.ruleId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.admission.ruleId))) invalid("Policy rule IDs must be opaque identifiers.");
  if (entry.admission.reason !== undefined && !["active_claim", "completed", "dispatched", "approval_reused"].includes(entry.admission.reason)) invalid("Unknown admission reason.");
  if (entry.event === "policy_denied" && !entry.admission.ruleId) invalid("A policy denial must name its rule.");
  if (entry.event === "duplicate") {
    if (entry.registry || !entry.admission.reason || entry.verdict !== "prewrite") invalid("Duplicate decisions cannot alter a lease.");
    return;
  }
  const lease = entry.registry;
  if (!lease || !uuidPattern.test(lease.leaseId) || !Number.isSafeInteger(lease.fence) || lease.fence < 1
    || !Number.isFinite(Date.parse(lease.expiresAt))) invalid("Registry entries require valid fenced lease metadata.");
  validateDigest(lease.tokenHash);
  const action = previous.filter((item) => item.destinationAccount === entry.destinationAccount
    && item.actionId?.toLowerCase() === entry.actionId?.toLowerCase());
  const lifecycle = action.filter((item) => item.registry && item.event !== "policy_denied");
  const current = lifecycle.at(-1);
  if (entry.event === "claim") {
    if (entry.verdict !== "prewrite" || Date.parse(lease.expiresAt) <= Date.parse(entry.timestamp)) invalid("A claim needs a future expiry and cannot imply execution.");
    if (action.some((item) => item.event === "attempt" || item.destinationId || item.writeMayHaveHappened)) invalid("A possible or completed write cannot be reclaimed.");
    if (current && current.event !== "claim_released" && current.event !== "claim_expired") invalid("An active lease cannot be replaced.");
    const lastFence = Math.max(0, ...lifecycle.map((item) => item.registry!.fence));
    if (lease.fence !== lastFence + 1) invalid("Claim fencing tokens must increase monotonically.");
    if (action.some((item) => item.event === "claim" && (item.surface !== entry.surface
      || item.packageDigest !== entry.packageDigest || item.approvalId !== entry.approvalId))) invalid("An approved action cannot change its identity on reclaim.");
    return;
  }
  if (!current?.registry || current.registry.leaseId !== lease.leaseId || current.registry.tokenHash !== lease.tokenHash
    || current.registry.fence !== lease.fence || current.registry.expiresAt !== lease.expiresAt
    || current.surface !== entry.surface || current.attemptId !== entry.attemptId
    || current.packageDigest !== entry.packageDigest || current.approvalId !== entry.approvalId) invalid("A stale or different lease cannot change registry state.");
  if (entry.event === "claim_completed") {
    if (current.event !== "attempt" || entry.verdict !== "complete") invalid("Only an audited dispatched action can complete.");
    return;
  }
  if (current.event !== "claim") invalid("Only an unused claim can be dispatched, released, denied, or expired.");
  if (entry.event === "claim_expired") {
    if (Date.parse(entry.timestamp) < Date.parse(lease.expiresAt)) invalid("A live lease cannot expire early.");
  } else if (Date.parse(entry.timestamp) >= Date.parse(lease.expiresAt)) invalid("An expired lease cannot authorize a change.");
  if (entry.event === "attempt" && (entry.writeMayHaveHappened !== true || entry.verdict !== "delivery_unknown")) invalid("Dispatch must durably record execution uncertainty.");
}

function validateEntry(entry: AuditEntry, previous: readonly AuditEntry[]): void {
  if (!entry || typeof entry !== "object") invalid("An audit entry is required.");
  if (typeof entry.id !== "string" || !entry.id.trim()) invalid("Every entry needs an ID.");
  if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) invalid("Every entry needs a valid timestamp.");
  if (!["attempt", "classification", "observation", "binding", "recheck"].includes(entry.event) && !admissionEvents.has(entry.event)) invalid("Unknown audit event.");
  validateEvidence(entry.evidence);
  if (!entry.evidence.length) invalid("Every audit entry needs evidence explaining its verdict.");
  if (entry.evidenceSource !== undefined && !["host-supplied", "receipts-read"].includes(entry.evidenceSource)) invalid("Unknown evidence source.");
  if (entry.independentlyVerified !== undefined && entry.independentlyVerified !== (entry.evidenceSource === "receipts-read")) invalid("Independent verification requires a connector read.");
  if (entry.observedAt !== undefined && !Number.isFinite(Date.parse(entry.observedAt))) invalid("Observation timestamp is invalid.");
  if (entry.observedPackageDigest !== undefined) validateDigest(entry.observedPackageDigest);
  const classification = classify(entry);
  validateAdmissionEntry(entry, previous);
  if (entry.verdict !== classification.verdict) invalid("The recorded verdict contradicts its evidence.");
  if (previous.some((item) => item.id === entry.id)) throw new ReceiptsError("duplicate_entry", `Entry ${entry.id} is already recorded.`);
  const sameAttempt = previous.filter((item) => item.attemptId === entry.attemptId);
  if (sameAttempt.some((item) => item.surface !== entry.surface || item.packageDigest !== entry.packageDigest
    || item.actionId !== entry.actionId || item.destinationAccount !== entry.destinationAccount || item.approvalId !== entry.approvalId)) {
    invalid("An attempt ID cannot change surface or approved package digest.");
  }
  if (sameAttempt.some((item) => item.idempotencyKey && entry.idempotencyKey && item.idempotencyKey !== entry.idempotencyKey)) {
    invalid("An attempt ID cannot change idempotency key.");
  }
  if (entry.destinationId && sameAttempt.some((item) => item.destinationId && item.destinationId !== entry.destinationId)) {
    invalid("An attempt cannot silently switch destination object IDs.");
  }
  if (entry.event === "attempt" && sameAttempt.some((item) => item.event === "attempt")) {
    invalid("An attempt has already been claimed.");
  }
  if (entry.event === "attempt" && previous.some((item) => item.destinationAccount === entry.destinationAccount
    && item.actionId?.toLowerCase() === entry.actionId?.toLowerCase() && item.attemptId !== entry.attemptId
    && (item.writeMayHaveHappened || item.destinationId || item.verdict !== "prewrite"))) {
    throw new ReceiptsError("duplicate_attempt", "This action already has a possible write. Observe the existing destination instead.");
  }
  if (classification.mayRearm) {
    const priorAttempt = previous.filter((item) => item.attemptId === entry.rearm!.previousAttemptId);
    if (!priorAttempt.length || priorAttempt.some((item) => item.surface !== entry.surface
      || item.packageDigest !== entry.rearm!.previousDigest || item.verdict !== "prewrite")
      || !priorAttempt.some((item) => item.neverReached === true)) {
      throw new ReceiptsError("invalid_rearm", "Rearming requires an audited prewrite attempt with the previous digest and affirmative never-reached evidence.");
    }
  }
  if (entry.event === "observation" || entry.event === "recheck") {
    if (!entry.destinationId || !entry.evidence.some((evidence) =>
      (evidence.source === "provider" || evidence.source === "human") && evidence.destinationId === entry.destinationId)) {
      invalid("An observation needs provider or human evidence for the exact destination object.");
    }
    if (previous.some((item) => item.destinationId === entry.destinationId
      && item.surface === entry.surface && item.destinationAccount === entry.destinationAccount
      && item.packageDigest === entry.packageDigest && item.attemptId !== entry.attemptId)) {
      throw new ReceiptsError("ambiguous_destination", "This destination object and digest already belong to another attempt. Reconcile the original attempt instead.");
    }
  }
  if (entry.event === "binding") {
    if (classification.verdict !== "complete") invalid("A binding must bind the exact approved digest.");
    const reference = entry.evidence.find((evidence) => evidence.source === "binding"
      && evidence.destinationId === entry.destinationId && evidence.packageDigest === entry.packageDigest)?.reference;
    const observation = previous.find((item) => item.id === reference);
    if (!observation || !sameScope(observation, entry) || observation.attemptId !== entry.attemptId
      || !matchesObservation(observation, entry.destinationId!, entry.packageDigest)) {
      throw new ReceiptsError("observation_required", "Binding requires an earlier audited observation of this object and exact package digest.");
    }
    if (entry.evidenceSource !== undefined && (entry.evidenceSource !== (observation.evidenceSource ?? "host-supplied")
      || entry.observedAt !== (observation.observedAt ?? observation.timestamp))) invalid("Binding provenance must match its exact observation.");
  } else if (classification.verdict === "complete") {
    if (!previous.some((item) => item.event === "binding" && item.verdict === "complete"
      && item.surface === entry.surface && item.attemptId === entry.attemptId
      && item.destinationId === entry.destinationId && item.packageDigest === entry.packageDigest)) {
      throw new ReceiptsError("observation_required", "Record an observation and bind it before recording completion.");
    }
  }
}

function validateHistory(entries: readonly AuditEntry[]): void {
  if (!Array.isArray(entries)) throw new ReceiptsError("invalid_store", "AuditStore.read must synchronously return an array.");
  const previous: AuditEntry[] = [];
  for (const entry of entries) {
    validateEntry(entry, previous);
    previous.push(entry);
  }
}

function ensureSyncStore(store: AuditStore): void {
  if (!store || typeof store.read !== "function" || typeof store.append !== "function"
    || store.read.constructor.name === "AsyncFunction" || store.append.constructor.name === "AsyncFunction") {
    throw new ReceiptsError("invalid_store", "AuditStore requires synchronous read and atomic append methods.");
  }
}

function readStore(store: AuditStore): readonly AuditEntry[] {
  ensureSyncStore(store);
  const entries = store.read();
  validateHistory(entries);
  return detached(entries);
}

/** Internal validated snapshot for CAS registry decisions. */
export function readAuditEntries(store: AuditStore): readonly AuditEntry[] { return readStore(store); }

export function createAuditEntry(write: OutwardWrite, event: AuditEvent = "classification"): AuditEntry {
  requireAction(write);
  const entry: AuditEntry = { ...write, id: randomUUID(), timestamp: new Date().toISOString(), event, verdict: classify(write).verdict,
    evidence: write.evidence?.length ? write.evidence : [{ source: "executor", detail: summaries.executor }] };
  return normalizedEntry(entry, []);
}

function appendEntry(entry: AuditEntry, store: AuditStore, expectedLength?: number, trustedRead = false, trustedAdmission = false): AuditEntry {
  const entries = readStore(store);
  // A caller's proposal was built against its earlier snapshot. If that tail
  // changed, retry the decision before interpreting stale lifecycle metadata.
  // The store still compares the same length atomically while holding its lock.
  if (expectedLength !== undefined && expectedLength !== entries.length) {
    throw new ReceiptsError("audit_conflict", "The audit changed before validation. No entry was written.");
  }
  validateEvidence(entry.evidence);
  const copy = normalizedEntry(entry, entries, trustedRead, trustedAdmission);
  validateEntry(copy, entries);
  if (trustedRead) connectorEntries.add(copy);
  if (trustedAdmission) admissionEntries.add(copy);
  const result: unknown = store.append(copy, expectedLength ?? entries.length);
  if (result !== undefined) throw new ReceiptsError("invalid_store", "AuditStore.append must finish synchronously and return void.");
  return copy;
}

/** Internal entry point used by admission.ts; deliberately omitted from package exports. */
export function recordAdmission(entry: AuditEntry, store: AuditStore, expectedLength: number): AuditEntry {
  return appendEntry(entry, store, expectedLength, false, true);
}

/** Public evidence is always cooperative, regardless of caller-supplied trust flags. */
export function record(entry: AuditEntry, store: AuditStore = getDefaultStore(), expectedLength?: number): void {
  appendEntry(entry, store, expectedLength);
}

function receiptFrom(entry: AuditEntry): Receipt {
  return { destinationId: entry.destinationId!, packageDigest: entry.packageDigest, surface: entry.surface,
    attemptId: entry.attemptId, actionId: entry.actionId ?? "legacy-unknown", destinationAccount: entry.destinationAccount ?? "legacy-unknown",
    approvalId: entry.approvalId ?? "legacy-unknown",
    observationId: entry.event === "binding" ? entry.evidence.find((item) => item.source === "binding"
      && item.destinationId === entry.destinationId && item.packageDigest === entry.packageDigest)!.reference! : entry.id,
    auditEntryId: entry.id, timestamp: entry.timestamp, evidenceSource: entry.evidenceSource ?? "host-supplied",
    independentlyVerified: entry.evidenceSource === "receipts-read", observedAt: entry.observedAt ?? entry.timestamp,
    verdict: entry.verdict, ...(entry.observedPackageDigest ? { observedPackageDigest: entry.observedPackageDigest } : {}) };
}

function unambiguous(entries: readonly AuditEntry[]): void {
  if (new Set(entries.map((entry) => JSON.stringify([entry.surface, entry.destinationAccount, entry.actionId, entry.attemptId]))).size > 1) {
    throw new ReceiptsError("ambiguous_destination", "The object and digest match multiple scopes. Supply destinationAccount and actionId.");
  }
}

/** Historical immutable receipt. This performs no new provider read. */
export function getReceipt(destinationId: string, packageDigest: string, store: AuditStore = getDefaultStore(), scope?: ReceiptScope): Receipt | undefined {
  validateDigest(packageDigest);
  const entries = readStore(store).filter((entry) => entry.destinationId === destinationId && entry.packageDigest === packageDigest && inScope(entry, scope));
  unambiguous(entries);
  const binding = entries.find((entry) => entry.event === "binding" && entry.verdict === "complete");
  return binding ? receiptFrom(binding) : undefined;
}

/** Bind existing audited read-back; provenance comes only from that exact observation. */
export function bind(destinationId: string, packageDigest: string, store: AuditStore = getDefaultStore(), scope?: ReceiptScope): Binding {
  validateDigest(packageDigest);
  const entries = readStore(store);
  const observations = entries.filter((entry) => matchesObservation(entry, destinationId, packageDigest) && inScope(entry, scope));
  if (!observations.length) throw new ReceiptsError("observation_required", "No audited observation matches this object and exact approved digest.");
  unambiguous(observations);
  const observation = observations.at(-1)!;
  const priorBinding = entries.find((entry) => entry.event === "binding" && entry.destinationId === destinationId
    && entry.packageDigest === packageDigest && sameScope(entry, observation) && entry.attemptId === observation.attemptId);
  if (priorBinding) return receiptFrom(priorBinding);
  const entry = createAuditEntry({
    surface: observation.surface, attemptId: observation.attemptId, actionId: observation.actionId,
    destinationAccount: observation.destinationAccount, approvalId: observation.approvalId, packageDigest, destinationId,
    ...(observation.idempotencyKey ? { idempotencyKey: observation.idempotencyKey } : {}), boundPackageDigest: packageDigest,
    evidence: [{ source: "binding", detail: summaries.binding, destinationId, packageDigest,
      reference: observation.id, observedAt: observation.observedAt ?? observation.timestamp }],
  }, "binding");
  return receiptFrom(appendEntry(entry, store, entries.length));
}

/** Historical verification; use observeDestination(recheck:true) to inspect current state. */
export function verify(destinationId: string, packageDigest: string, store: AuditStore = getDefaultStore(), scope?: ReceiptScope): Verdict {
  validateDigest(packageDigest);
  if (typeof destinationId !== "string" || !destinationId.trim()) throw new ReceiptsError("invalid_destination_id", "A destination ID is required.");
  const entries = readStore(store).filter((entry) => inScope(entry, scope));
  const matching = entries.filter((entry) => entry.destinationId === destinationId && entry.packageDigest === packageDigest);
  unambiguous(matching);
  if (matching.some((entry) => entry.event === "binding" && entry.verdict === "complete")) return "complete";
  if (matching.some((entry) => entry.verdict === "delivery_unknown")) return "delivery_unknown";
  if (entries.some((entry) => entry.destinationId === destinationId)) return "package_unverified";
  if (entries.some((entry) => entry.packageDigest === packageDigest && entry.verdict === "delivery_unknown")) return "delivery_unknown";
  return "prewrite";
}

/** Execute trusted local connector code; wire data alone cannot create this provenance. */
export async function observeDestination(connector: DestinationConnector, request: ConnectorRequest, store: AuditStore = getDefaultStore()): Promise<Receipt> {
  requireAction(request);
  if (!connector || typeof connector.read !== "function" || connector.surface !== request.surface) {
    throw new ReceiptsError("invalid_connector", "A locally configured connector for the exact surface is required.");
  }
  const snapshot = detached(request);
  const history = readStore(store);
  const attempt = history.find((entry) => entry.attemptId === snapshot.attemptId);
  if (attempt && (!sameScope(attempt, snapshot) || attempt.packageDigest !== snapshot.packageDigest || attempt.approvalId !== snapshot.approvalId)) {
    throw new ReceiptsError("invalid_entry", "A connector read cannot change the approved action identity.");
  }
  const originalBinding = history.find((entry) => entry.event === "binding" && sameScope(entry, snapshot)
    && entry.attemptId === snapshot.attemptId && entry.packageDigest === snapshot.packageDigest
    && (snapshot.destinationId === undefined || entry.destinationId === snapshot.destinationId));
  if (snapshot.recheck && !originalBinding) {
    throw new ReceiptsError("observation_required", "Rechecking requires an existing receipt for the exact action.");
  }
  let observed;
  try { observed = await connector.read(Object.freeze(detached(snapshot))); }
  catch (error) {
    if (error instanceof ReceiptsError && error.code === "account_mismatch") {
      throw new ReceiptsError("account_mismatch", "The connector refused a different destination account.");
    }
    if (error instanceof ReceiptsError && error.code === "object_mismatch") {
      throw new ReceiptsError("object_mismatch", "The connector refused a different destination object.");
    }
    throw new ReceiptsError("connector_read_failed", "The destination read failed. No verification was issued; do not repeat the write.");
  }
  if (!observed || observed.destinationAccount !== snapshot.destinationAccount) {
    throw new ReceiptsError("account_mismatch", "The connector read a different destination account.");
  }
  if (snapshot.destinationId !== undefined && observed.destinationId !== snapshot.destinationId) {
    throw new ReceiptsError("object_mismatch", "The connector read a different destination object.");
  }
  validateDigest(observed.packageDigest);
  if (typeof observed.observedAt !== "string" || !Number.isFinite(Date.parse(observed.observedAt))) {
    throw new ReceiptsError("invalid_observation", "The connector must return a valid observation timestamp.");
  }
  const observation = createAuditEntry({ surface: snapshot.surface, attemptId: snapshot.attemptId,
    actionId: snapshot.actionId, destinationAccount: snapshot.destinationAccount, approvalId: snapshot.approvalId,
    packageDigest: snapshot.packageDigest, destinationId: observed.destinationId, publicObjectExists: true,
    ...(snapshot.recheck && observed.packageDigest === snapshot.packageDigest ? { boundPackageDigest: snapshot.packageDigest } : {}),
    evidence: [{ source: "provider", detail: summaries.provider, destinationId: observed.destinationId,
      packageDigest: observed.packageDigest, observedAt: observed.observedAt }],
  }, snapshot.recheck ? "recheck" : "observation");
  observation.observedAt = observed.observedAt;
  observation.observedPackageDigest = observed.packageDigest;
  const stored = appendEntry(observation, store, undefined, true);
  if (observed.packageDigest !== snapshot.packageDigest) return receiptFrom(stored);
  if (snapshot.recheck) return receiptFrom(stored);
  const binding = createAuditEntry({ surface: stored.surface, attemptId: stored.attemptId,
    actionId: stored.actionId, destinationAccount: stored.destinationAccount, approvalId: stored.approvalId,
    packageDigest: stored.packageDigest, destinationId: stored.destinationId, boundPackageDigest: stored.packageDigest,
    evidence: [{ source: "binding", detail: summaries.binding, destinationId: stored.destinationId,
      packageDigest: stored.packageDigest, reference: stored.id, observedAt: stored.observedAt }],
  }, "binding");
  return receiptFrom(appendEntry(binding, store));
}

export function assertComplete(result: Classification | Verdict): void;
export function assertComplete(destinationId: string, packageDigest: string, store?: AuditStore): void;
export function assertComplete(result: Classification | Verdict | string, packageDigest?: string, store?: AuditStore): void {
  const verdict = packageDigest !== undefined ? verify(result as string, packageDigest, store)
    : typeof result === "string" ? result : result.verdict;
  if (verdict !== "complete") throw new ReceiptsError("not_complete", `Cannot claim completion: ${verdict}.`);
}

/** In-memory backend for embedded use and tests. JSONL is the default backend. */
export class MemoryAuditStore implements AuditStore {
  #entries: AuditEntry[] = [];
  read(): readonly AuditEntry[] { return detached(this.#entries); }
  append(entry: AuditEntry, expectedLength?: number): void {
    if (expectedLength !== undefined && expectedLength !== this.#entries.length) {
      throw new ReceiptsError("audit_conflict", "The audit changed before append. No entry was written.");
    }
    validateEvidence(entry.evidence);
    const copy = normalizedEntry(entry, this.#entries, connectorEntries.has(entry), admissionEntries.has(entry));
    validateEntry(copy, this.#entries);
    this.#entries.push(copy);
  }
}

type Envelope = AuditEnvelope;

function envelopeHash(value: Omit<Envelope, "hash">): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Offline verification: no files or provider reads. Does not establish signer trust. */
export function validateAuditChain(chain: AuditChain): void {
  try {
    if (!chain || !Array.isArray(chain.envelopes) || !chain.head) throw new Error("Invalid chain shape.");
    let previousHash: string | null = null;
    const entries: AuditEntry[] = [];
    for (const envelope of chain.envelopes) {
      const { hash, ...payload } = envelope;
      if (envelope.version !== 1 || envelope.sequence !== entries.length + 1
        || envelope.previousHash !== previousHash || envelopeHash(payload) !== hash) throw new Error("Invalid chain link.");
      validateEntry(envelope.entry, entries);
      entries.push(envelope.entry);
      previousHash = hash;
    }
    if (chain.head.count !== entries.length || chain.head.hash !== previousHash) throw new Error("Head checkpoint mismatch.");
  } catch {
    throw new ReceiptsError("audit_corrupt", "The exported audit chain failed integrity validation.");
  }
}

/** Opt-in local export. Custom stores are trusted; their entries are canonically chained here. */
export function exportAuditChain(store: AuditStore = getDefaultStore()): AuditChain {
  if (store instanceof JsonlAuditStore) return store.exportChain();
  const entries = readStore(store);
  const envelopes: AuditEnvelope[] = [];
  for (const entry of entries) {
    const payload: Omit<AuditEnvelope, "hash"> = { version: 1, sequence: envelopes.length + 1,
      previousHash: envelopes.at(-1)?.hash ?? null, entry };
    envelopes.push({ ...payload, hash: envelopeHash(payload) });
  }
  return detached({ envelopes, head: { count: envelopes.length, hash: envelopes.at(-1)?.hash ?? null } });
}

/**
 * Hash-chained JSONL plus a local head checkpoint. The checkpoint detects tail
 * truncation while retained. Neither file is a cryptographic signature or an
 * external anchor: an attacker able to rewrite both can forge the history.
 * A crash during append fails closed; recovery requires operator inspection.
 */
export class JsonlAuditStore implements AuditStore {
  readonly path: string;
  constructor(path = process.env.RECEIPTS_AUDIT_PATH ?? ".receipts/audit.jsonl") { this.path = resolve(path); }

  #readEnvelopes(): Envelope[] {
    const headPath = `${this.path}.head`;
    if (!existsSync(this.path)) {
      if (existsSync(headPath)) throw new ReceiptsError("audit_corrupt", "Audit log is missing but its head checkpoint exists.");
      return [];
    }
    const text = readFileSync(this.path, "utf8");
    if (text && !text.endsWith("\n")) throw new ReceiptsError("audit_corrupt", "Audit log contains an incomplete final entry.");
    const lines = text ? text.slice(0, -1).split("\n") : [];
    const envelopes: Envelope[] = [];
    const entries: AuditEntry[] = [];
    try {
      for (const line of lines) {
        const value = JSON.parse(line) as Envelope;
        const { hash, ...payload } = value;
        if (value.version !== 1 || value.sequence !== envelopes.length + 1
          || value.previousHash !== (envelopes.at(-1)?.hash ?? null) || hash !== envelopeHash(payload)) {
          throw new Error("Invalid hash chain.");
        }
        validateEntry(value.entry, entries);
        envelopes.push(value);
        entries.push(value.entry);
      }
      if (envelopes.length || existsSync(headPath)) {
        const head = JSON.parse(readFileSync(headPath, "utf8")) as { count: number; hash: string | null };
        if (head.count !== envelopes.length || head.hash !== (envelopes.at(-1)?.hash ?? null)) throw new Error("Head checkpoint mismatch.");
      }
    } catch (error) {
      throw new ReceiptsError("audit_corrupt", `Audit integrity validation failed: ${error instanceof Error ? error.message : "invalid log"}`);
    }
    return envelopes;
  }

  read(): readonly AuditEntry[] {
    return detached(this.#readSnapshot().map((value) => value.entry));
  }

  exportChain(): AuditChain {
    const envelopes = this.#readSnapshot();
    return detached({ envelopes, head: { count: envelopes.length, hash: envelopes.at(-1)?.hash ?? null } });
  }

  #readSnapshot(): Envelope[] {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let lock: number;
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ReceiptsError("audit_locked", "Audit is locked; no unsafe concurrent read was attempted.");
      throw error;
    }
    try { return this.#readEnvelopes(); }
    finally { closeSync(lock); unlinkSync(lockPath); }
  }

  append(entry: AuditEntry, expectedLength?: number): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let lock: number;
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ReceiptsError("audit_locked", "Audit is locked. No entry was written; inspect a stale lock before removing it.");
      }
      throw error;
    }
    try {
      const envelopes = this.#readEnvelopes();
      if (expectedLength !== undefined && expectedLength !== envelopes.length) {
        throw new ReceiptsError("audit_conflict", "The audit changed before append. No entry was written.");
      }
      validateEvidence(entry.evidence);
      const copy = normalizedEntry(entry, envelopes.map((value) => value.entry), connectorEntries.has(entry), admissionEntries.has(entry));
      validateEntry(copy, envelopes.map((value) => value.entry));
      const payload: Omit<Envelope, "hash"> = { version: 1, sequence: envelopes.length + 1,
        previousHash: envelopes.at(-1)?.hash ?? null, entry: copy };
      const envelope: Envelope = { ...payload, hash: envelopeHash(payload) };
      const fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try {
        const data = Buffer.from(`${canonicalJson(envelope)}\n`);
        let offset = 0;
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      const tempHead = `${this.path}.head.${randomUUID()}.tmp`;
      try {
        writeFileSync(tempHead, canonicalJson({ count: envelope.sequence, hash: envelope.hash }), { flag: "wx", mode: 0o600 });
        const headFd = openSync(tempHead, "r");
        try { fsyncSync(headFd); } finally { closeSync(headFd); }
        renameSync(tempHead, `${this.path}.head`);
      } finally { if (existsSync(tempHead)) unlinkSync(tempHead); }
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }
}

export function getDefaultStore(): AuditStore { return new JsonlAuditStore(); }
