import { randomUUID, createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { classify, validateDigest, validateEvidence } from "./classify.js";
import {
  ReceiptsError, type AuditEntry, type AuditEvent, type AuditStore, type Binding,
  type Classification, type OutwardWrite, type Verdict,
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

function matchesObservation(entry: AuditEntry, destinationId: string, digest: string): boolean {
  return entry.event === "observation" && entry.destinationId === destinationId && entry.packageDigest === digest
    && entry.evidence.some((evidence) => (evidence.source === "provider" || evidence.source === "human")
      && evidence.destinationId === destinationId && evidence.packageDigest === digest);
}

function validateEntry(entry: AuditEntry, previous: readonly AuditEntry[]): void {
  if (!entry || typeof entry !== "object") invalid("An audit entry is required.");
  if (typeof entry.id !== "string" || !entry.id.trim()) invalid("Every entry needs an ID.");
  if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) invalid("Every entry needs a valid timestamp.");
  if (!["attempt", "classification", "observation", "binding"].includes(entry.event)) invalid("Unknown audit event.");
  validateEvidence(entry.evidence);
  if (!entry.evidence.length) invalid("Every audit entry needs evidence explaining its verdict.");
  const classification = classify(entry);
  if (entry.verdict !== classification.verdict) invalid("The recorded verdict contradicts its evidence.");
  if (previous.some((item) => item.id === entry.id)) throw new ReceiptsError("duplicate_entry", `Entry ${entry.id} is already recorded.`);
  const sameAttempt = previous.filter((item) => item.attemptId === entry.attemptId);
  if (sameAttempt.some((item) => item.surface !== entry.surface || item.packageDigest !== entry.packageDigest)) {
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
  if (classification.mayRearm) {
    const priorAttempt = previous.filter((item) => item.attemptId === entry.rearm!.previousAttemptId);
    if (!priorAttempt.length || priorAttempt.some((item) => item.surface !== entry.surface
      || item.packageDigest !== entry.rearm!.previousDigest || item.verdict !== "prewrite")
      || !priorAttempt.some((item) => item.neverReached === true)) {
      throw new ReceiptsError("invalid_rearm", "Rearming requires an audited prewrite attempt with the previous digest and affirmative never-reached evidence.");
    }
  }
  if (entry.event === "observation") {
    if (!entry.destinationId || !entry.evidence.some((evidence) =>
      (evidence.source === "provider" || evidence.source === "human") && evidence.destinationId === entry.destinationId)) {
      invalid("An observation needs provider or human evidence for the exact destination object.");
    }
    if (previous.some((item) => item.destinationId === entry.destinationId
      && item.surface === entry.surface && item.packageDigest === entry.packageDigest
      && item.attemptId !== entry.attemptId)) {
      throw new ReceiptsError("ambiguous_destination", "This destination object and digest already belong to another attempt. Reconcile the original attempt instead.");
    }
  }
  if (entry.event === "binding") {
    if (classification.verdict !== "complete") invalid("A binding must bind the exact approved digest.");
    const reference = entry.evidence.find((evidence) => evidence.source === "binding"
      && evidence.destinationId === entry.destinationId && evidence.packageDigest === entry.packageDigest)?.reference;
    const observation = previous.find((item) => item.id === reference);
    if (!observation || observation.surface !== entry.surface || observation.attemptId !== entry.attemptId
      || !matchesObservation(observation, entry.destinationId!, entry.packageDigest)) {
      throw new ReceiptsError("observation_required", "Binding requires an earlier audited observation of this object and exact package digest.");
    }
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

export function createAuditEntry(write: OutwardWrite, event: AuditEvent = "classification"): AuditEntry {
  const verdict = classify(write).verdict;
  return detached({ ...write, id: randomUUID(), timestamp: new Date().toISOString(), event, verdict,
    evidence: write.evidence?.length ? write.evidence : [{ source: "executor", detail: "Classification of normalized execution evidence; no destination observation is implied." }] });
}

/** Validate and append; no existing entry is replaced or deleted. */
export function record(entry: AuditEntry, store: AuditStore = getDefaultStore(), expectedLength?: number): void {
  const copy = detached(entry);
  const entries = readStore(store);
  validateEntry(copy, entries);
  const result: unknown = store.append(copy, expectedLength ?? entries.length);
  if (result !== undefined) throw new ReceiptsError("invalid_store", "AuditStore.append must finish synchronously and return void.");
}

function bindingFrom(entry: AuditEntry): Binding {
  return { destinationId: entry.destinationId!, packageDigest: entry.packageDigest, surface: entry.surface,
    attemptId: entry.attemptId, observationId: entry.evidence.find((item) => item.source === "binding"
      && item.destinationId === entry.destinationId && item.packageDigest === entry.packageDigest)!.reference!,
    auditEntryId: entry.id, timestamp: entry.timestamp };
}

/** Bind existing, audited read-back evidence. This never invents an object ID. */
export function bind(destinationId: string, packageDigest: string, store: AuditStore = getDefaultStore()): Binding {
  validateDigest(packageDigest);
  const entries = readStore(store);
  const observations = entries.filter((entry) => matchesObservation(entry, destinationId, packageDigest));
  if (!observations.length) throw new ReceiptsError("observation_required", "No audited provider or human observation matches this object and exact approved digest.");
  const surfaces = new Set(observations.map((entry) => entry.surface));
  const attempts = new Set(observations.map((entry) => entry.attemptId));
  if (surfaces.size !== 1 || attempts.size !== 1) {
    throw new ReceiptsError("ambiguous_destination", "This ID and digest resolve to multiple surfaces or attempts. Use a canonical ID and reconcile the original attempt.");
  }
  const observation = observations.at(-1)!;
  const priorBinding = [...entries].reverse().find((entry) => entry.event === "binding" && entry.destinationId === destinationId
    && entry.packageDigest === packageDigest && entry.surface === observation.surface && entry.attemptId === observation.attemptId);
  if (priorBinding) return bindingFrom(priorBinding);
  const entry = createAuditEntry({
    surface: observation.surface, attemptId: observation.attemptId, packageDigest, destinationId,
    ...(observation.idempotencyKey ? { idempotencyKey: observation.idempotencyKey } : {}),
    boundPackageDigest: packageDigest,
    evidence: [{ source: "binding", detail: "Bound the approved digest to an already audited destination observation.",
      destinationId, packageDigest, reference: observation.id, observedAt: observation.timestamp }],
  }, "binding");
  record(entry, store, entries.length);
  return bindingFrom(entry);
}

/** Only audited bindings can return complete. A status flag cannot. */
export function verify(destinationId: string, packageDigest: string, store: AuditStore = getDefaultStore()): Verdict {
  validateDigest(packageDigest);
  if (typeof destinationId !== "string" || !destinationId.trim()) throw new ReceiptsError("invalid_destination_id", "A destination ID is required.");
  const entries = readStore(store);
  const matching = entries.filter((entry) => entry.destinationId === destinationId && entry.packageDigest === packageDigest);
  if (new Set(matching.map((entry) => entry.surface)).size > 1
    || new Set(matching.map((entry) => entry.attemptId)).size > 1) {
    throw new ReceiptsError("ambiguous_destination", "This ID and digest are ambiguous across surfaces or attempts.");
  }
  if (matching.some((entry) => entry.event === "binding" && entry.verdict === "complete")) return "complete";
  if (matching.some((entry) => entry.verdict === "delivery_unknown")) return "delivery_unknown";
  if (entries.some((entry) => entry.destinationId === destinationId)) return "package_unverified";
  if (entries.some((entry) => entry.packageDigest === packageDigest && entry.verdict === "delivery_unknown")) return "delivery_unknown";
  return "prewrite";
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
    const copy = detached(entry);
    validateEntry(copy, this.#entries);
    this.#entries.push(copy);
  }
}

interface Envelope {
  version: 1;
  sequence: number;
  previousHash: string | null;
  entry: AuditEntry;
  hash: string;
}

function envelopeHash(value: Omit<Envelope, "hash">): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
    if (existsSync(`${this.path}.lock`)) throw new ReceiptsError("audit_locked", "Audit is locked; no unsafe concurrent read was attempted.");
    return detached(this.#readEnvelopes().map((value) => value.entry));
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
      const copy = detached(entry);
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
