import {
  assertComplete as assertCoreComplete,
  bind,
  classify,
  createAuditEntry,
  getDefaultStore,
  getSurface,
  record,
  verify,
  type AuditStore,
  type Classification,
  type Evidence,
  type OutwardWrite,
} from "@77systems/receipts-core";
import { digestPayload, freezePayload } from "./digest.js";

export { canonicalSerialize, digestPayload, PAYLOAD_ENCODING } from "./digest.js";

export interface ExecuteContext<T> {
  readonly payload: Readonly<T>;
  readonly packageDigest: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
}

export interface ExecuteOptions<T> {
  surface: string;
  attemptId: string;
  /** Stable identity for the logical action, reused by every caller of it. */
  idempotencyKey: string;
  payload: T;
  /** The only outward-write callback. Its return value is never trusted proof. */
  execute: (context: ExecuteContext<T>) => unknown | Promise<unknown>;
}

export interface ReconcileOptions<T> {
  surface: string;
  attemptId: string;
  payload: T;
  /** A real object ID supplied by a person or provider; the adapter still reads it. */
  destinationId?: string;
}

export interface ExecutionReceipt {
  readonly surface: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly packageDigest: string;
  readonly destinationId: string | null;
  readonly classification: Readonly<Classification>;
  readonly auditEntryId: string;
  readonly execution: "returned" | "threw" | "reconciled";
}

export class DuplicateWriteError extends Error {
  readonly code = "duplicate_write_refused";
  constructor() {
    super("This attempt, idempotency key, or package already has an execution claim. Reconcile the existing destination; do not execute again.");
    this.name = "DuplicateWriteError";
  }
}

export class VerificationPendingError extends Error {
  readonly code = "verification_pending";
  constructor(message = "Cannot claim complete without a durable destination receipt bound to this approved package.") {
    super(message);
    this.name = "VerificationPendingError";
  }
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required.`);
  if (value !== value.trim()) throw new TypeError(`${field} must not contain surrounding whitespace.`);
  return value;
}

function executorEvidence(detail: string): Evidence[] {
  return [{ source: "executor", detail, observedAt: new Date().toISOString() }];
}

/**
 * Wrap every write at the actual executor boundary. Enforcement applies to
 * calls through this wrapper; it is not a sandbox for arbitrary application
 * code. All callers must share the same durable AuditStore and stable keys.
 */
export class ReceiptsClient {
  readonly store: AuditStore;

  constructor(options: { store?: AuditStore } = {}) {
    this.store = options.store ?? getDefaultStore();
  }

  async execute<T>(options: ExecuteOptions<T>): Promise<ExecutionReceipt> {
    getSurface(required(options.surface, "surface"));
    const attemptId = required(options.attemptId, "attemptId");
    const idempotencyKey = required(options.idempotencyKey, "idempotencyKey");
    // Snapshot and digest happen before the first external side effect.
    const payload = freezePayload(options.payload);
    const packageDigest = digestPayload(payload);
    const write: OutwardWrite = {
      surface: options.surface,
      attemptId,
      idempotencyKey,
      packageDigest,
      // A crash after this durable claim is conservatively unknown. There is
      // no safe gap in which a second process can assume the write never ran.
      writeMayHaveHappened: true,
      neverReached: false,
      evidence: executorEvidence("Execution claimed before dispatch. If interrupted, observe the destination; never retry automatically."),
    };
    const entries = this.store.read();
    if (entries.some((entry) =>
      entry.attemptId === attemptId ||
      entry.idempotencyKey === idempotencyKey ||
      (entry.surface === write.surface && entry.packageDigest === packageDigest)
    )) throw new DuplicateWriteError();

    // Atomic compare-and-append defeats two clients that read the same tail.
    // A conflict fails closed BEFORE execute; the wrapper never retries it.
    record(createAuditEntry(write, "attempt"), this.store, entries.length);

    try {
      await options.execute(Object.freeze({ payload, packageDigest, attemptId, idempotencyKey }));
    } catch {
      return this.finish({
        ...write,
        evidence: executorEvidence("The outward-write callback threw after execution began. A write may have happened; its result is unknown. No retry was attempted."),
      }, "threw");
    }

    // A successful API response is never sufficient. Only observe supplies
    // structured destination evidence, even if execute returned a post ID.
    return this.observe(write, "returned");
  }

  async reconcile<T>(options: ReconcileOptions<T>): Promise<ExecutionReceipt> {
    getSurface(required(options.surface, "surface"));
    required(options.attemptId, "attemptId");
    const packageDigest = digestPayload(options.payload);
    const attempts = this.store.read().filter((entry) =>
      entry.event === "attempt" && entry.attemptId === options.attemptId
    );
    if (attempts.length !== 1) throw new VerificationPendingError("Reconciliation requires one existing execution claim for this attempt.");
    const attempt = attempts[0]!;
    if (attempt.surface !== options.surface || attempt.packageDigest !== packageDigest) {
      throw new VerificationPendingError("Reconciliation surface or approved payload differs from the existing attempt.");
    }
    return this.observe({
      surface: attempt.surface,
      attemptId: attempt.attemptId,
      idempotencyKey: attempt.idempotencyKey,
      packageDigest,
      destinationId: options.destinationId,
      neverReached: false,
      writeMayHaveHappened: true,
    }, "reconciled");
  }

  /** Re-read durable state; a caller cannot turn a returned unknown into done. */
  claimComplete(receipt: ExecutionReceipt): string {
    if (receipt.classification.verdict !== "complete" || !receipt.destinationId) {
      throw new VerificationPendingError();
    }
    const entry = this.store.read().find((candidate) => candidate.id === receipt.auditEntryId);
    if (!entry || entry.event !== "classification" || entry.verdict !== "complete" ||
        entry.surface !== receipt.surface || entry.attemptId !== receipt.attemptId ||
        entry.packageDigest !== receipt.packageDigest || entry.destinationId !== receipt.destinationId) {
      throw new VerificationPendingError();
    }
    assertCoreComplete(classify(entry));
    if (verify(receipt.destinationId, receipt.packageDigest, this.store) !== "complete") {
      throw new VerificationPendingError();
    }
    return receipt.destinationId;
  }

  private async observe(write: OutwardWrite, execution: ExecutionReceipt["execution"]): Promise<ExecutionReceipt> {
    const observer = getSurface(write.surface).observe;
    if (!observer) {
      return this.finish({
        ...write,
        destinationId: undefined,
        evidence: executorEvidence("No destination observer is registered. The write result cannot establish completion."),
      }, execution);
    }

    let observed: Awaited<ReturnType<NonNullable<typeof observer>>>;
    try {
      observed = await observer(Object.freeze({ ...write }));
    } catch {
      return this.finish({
        ...write,
        destinationId: undefined,
        evidence: executorEvidence("Destination read-back could not be completed. Nothing was learned about delivery; no second write was attempted."),
      }, execution);
    }

    if (!observed || typeof observed.destinationId !== "string" || !observed.destinationId.trim() ||
        !Array.isArray(observed.evidence) ||
        !observed.evidence.some((evidence) =>
          evidence &&
          (evidence.source === "provider" || evidence.source === "human") &&
          evidence.destinationId === observed.destinationId &&
          typeof evidence.detail === "string" && evidence.detail.trim().length > 0
        ) || (write.destinationId && write.destinationId !== observed.destinationId)) {
      return this.finish({
        ...write,
        destinationId: undefined,
        evidence: executorEvidence("Destination read-back did not establish the requested object's identity. Completion remains blocked; no second write was attempted."),
      }, execution);
    }

    // The store's normal validators also enforce the registered ID pattern.
    // Failed persistence throws; it cannot return a successful completion.
    const payloadMatches = observed.packageDigest === write.packageDigest;
    const observationEvidence: Evidence[] = observed.evidence.map((evidence): Evidence => {
      if (!payloadMatches && evidence.packageDigest === write.packageDigest) {
        // Contradictory adapter output cannot leave an approved-digest token
        // behind for a later direct bind to promote. Retain placement only.
        const { packageDigest: _unconfirmedDigest, ...placement } = evidence;
        return placement;
      }
      return evidence;
    });
    const observation: OutwardWrite = {
      ...write,
      destinationId: observed.destinationId,
      publicObjectExists: true,
      writeMayHaveHappened: false,
      evidence: observationEvidence,
    };
    record(createAuditEntry(observation, "observation"), this.store);
    if (!payloadMatches || !observationEvidence.some((evidence) =>
      (evidence.source === "provider" || evidence.source === "human") &&
      evidence.destinationId === observed.destinationId && evidence.packageDigest === write.packageDigest
    )) {
      // The object exists even though the approved payload is not proven.
      // Preserve that placement instead of collapsing it into a lost response.
      return this.finish(observation, execution);
    }
    bind(observed.destinationId, write.packageDigest, this.store);
    const complete: OutwardWrite = { ...observation, boundPackageDigest: write.packageDigest };
    return this.finish(complete, execution);
  }

  private finish(write: OutwardWrite, execution: ExecutionReceipt["execution"]): ExecutionReceipt {
    const classification = classify(write);
    const entry = createAuditEntry(write, "classification");
    record(entry, this.store);
    return Object.freeze({
      surface: write.surface,
      attemptId: write.attemptId,
      idempotencyKey: write.idempotencyKey ?? "",
      packageDigest: write.packageDigest,
      destinationId: classification.destinationId,
      classification: Object.freeze(classification),
      auditEntryId: entry.id,
      execution,
    });
  }
}

export function createReceipts(options: { store?: AuditStore } = {}): ReceiptsClient {
  return new ReceiptsClient(options);
}
