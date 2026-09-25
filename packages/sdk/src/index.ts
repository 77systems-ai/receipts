import {
  assertComplete as assertCoreComplete,
  bind,
  classify,
  createAuditEntry,
  getDefaultStore,
  getSurface,
  observeDestination,
  record,
  verify,
  ReceiptsError,
  type AuditStore,
  type Classification,
  type DestinationConnector,
  type Evidence,
  type EvidenceSource,
  type OutwardWrite,
  type Receipt,
} from "@77systems/receipts-core";
import { digestPayload, freezePayload } from "./digest.js";

export { canonicalSerialize, digestPayload, PAYLOAD_ENCODING } from "./digest.js";

export interface ExecuteContext<T> {
  readonly payload: Readonly<T>;
  readonly packageDigest: string;
  readonly attemptId: string;
  readonly actionId: string;
  readonly destinationAccount: string;
  readonly approvalId: string;
  readonly idempotencyKey: string;
}

export interface ExecuteOptions<T> {
  surface: string;
  attemptId: string;
  /** Caller-generated UUID for one approved logical action. Reuse on uncertain retries. */
  actionId: string;
  /** Exact provider/account identity, including the repository or target when appropriate. */
  destinationAccount: string;
  /** Explicit approval identity; a new action needs a new approval. */
  approvalId: string;
  /** Optional provider key. Receipts deduplicates by destinationAccount + actionId. */
  idempotencyKey?: string;
  payload: T;
  /** The only outward-write callback. Its return value is never trusted proof. */
  execute: (context: ExecuteContext<T>) => unknown | Promise<unknown>;
}

export interface ReconcileOptions<T> {
  surface: string;
  attemptId: string;
  payload: T;
  /** An observed object ID is a read-back pointer, never completion evidence by itself. */
  destinationId?: string;
  /** Transient read-back coordinates, for example { issueNumber: 42 }. Never audited. */
  locator?: Record<string, string | number>;
  /** Trusted local connector code. Do not deserialize executable connectors from requests. */
  connector?: DestinationConnector;
}

export interface ExecutionReceipt {
  readonly surface: string;
  readonly attemptId: string;
  readonly actionId: string;
  readonly destinationAccount: string;
  readonly approvalId: string;
  readonly idempotencyKey: string;
  readonly packageDigest: string;
  readonly destinationId: string | null;
  readonly evidenceSource: EvidenceSource;
  readonly independentlyVerified: boolean;
  /** Null when no destination observation has occurred. It is never a freshness claim. */
  readonly observedAt: string | null;
  readonly observedPackageDigest?: string;
  readonly classification: Readonly<Classification>;
  readonly auditEntryId: string;
  readonly execution: "returned" | "threw" | "reconciled" | "rechecked";
}

export interface ReceiptsOptions {
  store?: AuditStore;
  connector?: DestinationConnector;
}

export class DuplicateWriteError extends Error {
  readonly code = "duplicate_write_refused";
  constructor() {
    super("This attempt or approved action already has an execution claim. Reconcile the existing destination; do not execute again. A separately approved action needs a new actionId and approvalId.");
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
  return [{ source: "executor", detail }];
}

function scope(write: OutwardWrite) {
  return { surface: write.surface, attemptId: write.attemptId, actionId: write.actionId, destinationAccount: write.destinationAccount };
}

/**
 * Wrap writes at the actual executor boundary. All callers must share the same
 * durable AuditStore and approved action identity. This is not a sandbox for
 * arbitrary application code or a substitute for the host's approval flow.
 */
export class ReceiptsClient {
  readonly store: AuditStore;
  readonly connector?: DestinationConnector;

  constructor(options: ReceiptsOptions = {}) {
    this.store = options.store ?? getDefaultStore();
    this.connector = options.connector;
  }

  async execute<T>(options: ExecuteOptions<T>): Promise<ExecutionReceipt> {
    getSurface(required(options.surface, "surface"));
    const attemptId = required(options.attemptId, "attemptId");
    const actionId = required(options.actionId, "actionId");
    const destinationAccount = required(options.destinationAccount, "destinationAccount");
    const approvalId = required(options.approvalId, "approvalId");
    const idempotencyKey = options.idempotencyKey === undefined
      ? `${destinationAccount}:${actionId}` : required(options.idempotencyKey, "idempotencyKey");
    // Snapshot and digest happen before the first external side effect.
    const payload = freezePayload(options.payload);
    const packageDigest = digestPayload(payload);
    const write: OutwardWrite = {
      surface: options.surface, attemptId, actionId, destinationAccount, approvalId, idempotencyKey, packageDigest,
      // A crash after this durable claim is conservatively unknown.
      writeMayHaveHappened: true,
      neverReached: false,
      evidence: executorEvidence("Execution claimed before dispatch. Observe the destination if interrupted; never retry automatically."),
    };
    // Validates UUID and account/approval shape before claiming or dispatching.
    const claim = createAuditEntry(write, "attempt");
    const entries = this.store.read();
    if (entries.some((entry) => entry.attemptId === attemptId ||
      (entry.destinationAccount === destinationAccount &&
        (entry.actionId?.toLowerCase() === actionId.toLowerCase() || entry.approvalId === approvalId)))) {
      throw new DuplicateWriteError();
    }
    // Atomic compare-and-append defeats two clients that read the same tail.
    record(claim, this.store, entries.length);
    try {
      await options.execute(Object.freeze({ payload, packageDigest, attemptId, actionId, destinationAccount, approvalId, idempotencyKey }));
    } catch {
      return this.finish({
        ...write,
        evidence: executorEvidence("The outward-write callback threw after execution began. Delivery is unknown; no retry was attempted."),
      }, "threw");
    }
    // Callback responses cannot mint evidence. A connector read needs explicit
    // read-back coordinates supplied via reconcile after execution.
    return this.observeCooperative(write, "returned");
  }

  async reconcile<T>(options: ReconcileOptions<T>): Promise<ExecutionReceipt> {
    return this.readExisting(options, false);
  }

  /** Append a new observation. Historical receipts retain their original time. */
  async recheck<T>(options: ReconcileOptions<T>): Promise<ExecutionReceipt> {
    return this.readExisting(options, true);
  }

  private async readExisting<T>(options: ReconcileOptions<T>, recheck: boolean): Promise<ExecutionReceipt> {
    getSurface(required(options.surface, "surface"));
    required(options.attemptId, "attemptId");
    const packageDigest = digestPayload(options.payload);
    const attempts = this.store.read().filter((entry) => entry.event === "attempt" && entry.attemptId === options.attemptId);
    if (attempts.length !== 1) throw new VerificationPendingError("Reconciliation requires one existing execution claim for this attempt.");
    const attempt = attempts[0]!;
    if (attempt.surface !== options.surface || attempt.packageDigest !== packageDigest) {
      throw new VerificationPendingError("Reconciliation surface or approved payload differs from the existing attempt.");
    }
    if (!attempt.actionId || !attempt.destinationAccount || !attempt.approvalId) {
      throw new VerificationPendingError("A legacy execution claim lacks the exact action, account, and approval identity required for a new receipt.");
    }
    const write: OutwardWrite = {
      surface: attempt.surface, attemptId: attempt.attemptId,
      actionId: attempt.actionId, destinationAccount: attempt.destinationAccount, approvalId: attempt.approvalId,
      idempotencyKey: attempt.idempotencyKey, packageDigest,
      destinationId: options.destinationId, neverReached: false, writeMayHaveHappened: true,
    };
    const execution = recheck ? "rechecked" : "reconciled";
    const connector = options.connector ?? this.connector;
    if (!connector) return this.observeCooperative(write, execution, recheck);
    let receipt: Receipt;
    try {
      receipt = await observeDestination(connector, {
        surface: write.surface, attemptId: write.attemptId, actionId: attempt.actionId,
        destinationAccount: attempt.destinationAccount, approvalId: attempt.approvalId,
        packageDigest, destinationId: options.destinationId, locator: options.locator, recheck,
      }, this.store);
    } catch (error) {
      // Failures to persist must propagate. Only typed read-back failures can
      // become an uncertain receipt, and arbitrary provider error text is lost.
      if (!(error instanceof ReceiptsError) || !["connector_read_failed", "account_mismatch", "object_mismatch"].includes(error.code)) throw error;
      return this.finish({ ...write, destinationId: undefined,
        evidence: executorEvidence("Destination read-back did not verify the exact account and object. No second write was attempted.") }, execution);
    }
    const entry = this.store.read().find((item) => item.id === receipt.auditEntryId);
    if (!entry) throw new VerificationPendingError("The connector receipt was not durably recorded.");
    return Object.freeze({
      surface: receipt.surface, attemptId: receipt.attemptId, actionId: receipt.actionId,
      destinationAccount: receipt.destinationAccount, approvalId: receipt.approvalId,
      idempotencyKey: attempt.idempotencyKey ?? "", packageDigest: receipt.packageDigest,
      destinationId: receipt.destinationId, evidenceSource: receipt.evidenceSource,
      independentlyVerified: receipt.independentlyVerified, observedAt: receipt.observedAt,
      ...(receipt.observedPackageDigest ? { observedPackageDigest: receipt.observedPackageDigest } : {}),
      classification: Object.freeze(classify(entry)), auditEntryId: receipt.auditEntryId, execution,
    });
  }

  /** Require durable proof and optionally an independently executed provider read. */
  claimComplete(receipt: ExecutionReceipt, options: { requireIndependent?: boolean } = {}): string {
    if (receipt.classification.verdict !== "complete" || !receipt.destinationId ||
        (options.requireIndependent && !receipt.independentlyVerified)) throw new VerificationPendingError();
    const entry = this.store.read().find((candidate) => candidate.id === receipt.auditEntryId);
    if (!entry || entry.verdict !== "complete" ||
        entry.surface !== receipt.surface || entry.attemptId !== receipt.attemptId ||
        entry.actionId !== receipt.actionId || entry.destinationAccount !== receipt.destinationAccount || entry.approvalId !== receipt.approvalId ||
        entry.packageDigest !== receipt.packageDigest || entry.destinationId !== receipt.destinationId ||
        (entry.evidenceSource ?? "host-supplied") !== receipt.evidenceSource ||
        (entry.independentlyVerified === true) !== receipt.independentlyVerified ||
        (entry.observedAt ?? null) !== receipt.observedAt ||
        entry.observedPackageDigest !== receipt.observedPackageDigest) throw new VerificationPendingError();
    assertCoreComplete(classify(entry));
    if (verify(receipt.destinationId, receipt.packageDigest, this.store, scope(entry)) !== "complete") throw new VerificationPendingError();
    return receipt.destinationId;
  }

  private async observeCooperative(write: OutwardWrite, execution: ExecutionReceipt["execution"], recheck = false): Promise<ExecutionReceipt> {
    const observer = getSurface(write.surface).observe;
    if (!observer) return this.finish({ ...write, destinationId: undefined,
      evidence: executorEvidence("No cooperative observer is registered. Reconcile with a destination connector and read-back coordinates.") }, execution);
    let observed: Awaited<ReturnType<NonNullable<typeof observer>>>;
    try { observed = await observer(Object.freeze({ ...write })); }
    catch {
      return this.finish({ ...write, destinationId: undefined,
        evidence: executorEvidence("Destination read-back could not be completed. Delivery remains unknown; no second write was attempted.") }, execution);
    }
    if (!observed || typeof observed.destinationId !== "string" || !observed.destinationId.trim() ||
        !Array.isArray(observed.evidence) || !observed.evidence.some((evidence) => evidence &&
          (evidence.source === "provider" || evidence.source === "human") && evidence.destinationId === observed.destinationId &&
          typeof evidence.detail === "string" && evidence.detail.trim().length > 0) ||
        (write.destinationId && write.destinationId !== observed.destinationId)) {
      return this.finish({ ...write, destinationId: undefined,
        evidence: executorEvidence("Cooperative read-back did not establish the requested object's identity. No second write was attempted.") }, execution);
    }
    const payloadMatches = observed.packageDigest === write.packageDigest;
    const observedAt = new Date().toISOString();
    const evidence: Evidence[] = observed.evidence.map((item): Evidence => {
      // Preserve source claims as cooperative evidence, but hash caller details
      // in core. Never store response bodies or permit contradicted binding.
      const { packageDigest: suppliedDigest, ...placement } = item;
      return { ...placement, observedAt: item.observedAt ?? observedAt,
        ...(payloadMatches || suppliedDigest !== write.packageDigest ? { packageDigest: suppliedDigest } : {}) };
    });
    const observation: OutwardWrite = { ...write, destinationId: observed.destinationId,
      publicObjectExists: true, writeMayHaveHappened: false, evidence };
    record(createAuditEntry(observation, recheck ? "recheck" : "observation"), this.store);
    if (!payloadMatches || !evidence.some((item) => (item.source === "provider" || item.source === "human") &&
      item.destinationId === observed.destinationId && item.packageDigest === write.packageDigest)) return this.finish(observation, execution);
    bind(observed.destinationId, write.packageDigest, this.store, scope(write));
    return this.finish({ ...observation, boundPackageDigest: write.packageDigest }, execution);
  }

  private finish(write: OutwardWrite, execution: ExecutionReceipt["execution"]): ExecutionReceipt {
    const classification = classify(write);
    const entry = createAuditEntry(write, "classification");
    record(entry, this.store);
    return Object.freeze({
      surface: write.surface, attemptId: write.attemptId, actionId: write.actionId!,
      destinationAccount: write.destinationAccount!, approvalId: write.approvalId!, idempotencyKey: write.idempotencyKey ?? "",
      packageDigest: write.packageDigest, destinationId: classification.destinationId,
      evidenceSource: "host-supplied", independentlyVerified: false, observedAt: entry.observedAt ?? null,
      ...(entry.observedPackageDigest ? { observedPackageDigest: entry.observedPackageDigest } : {}),
      classification: Object.freeze(classification), auditEntryId: entry.id, execution,
    });
  }
}

export function createReceipts(options: ReceiptsOptions = {}): ReceiptsClient {
  return new ReceiptsClient(options);
}
