export type Verdict = "prewrite" | "delivery_unknown" | "package_unverified" | "complete";
export type RetryLaw = "rearm_after_fix" | "never_auto_retry" | "never_second_post" | "none";

/** A trusted adapter or operator supplies evidence; core cannot authenticate it. */
export interface Evidence {
  source: "provider" | "human" | "executor" | "binding";
  detail: string;
  observedAt?: string;
  destinationId?: string;
  packageDigest?: string;
  reference?: string;
}

/**
 * Normalized, trusted input. Supplying boundPackageDigest to the pure classifier
 * describes a binding; it does not create a durable receipt. Use bind + verify
 * for audited completion. Observe callbacks must read back the actual payload.
 */
export interface OutwardWrite {
  surface: string;
  attemptId: string;
  packageDigest: string;
  idempotencyKey?: string;
  destinationId?: string;
  boundPackageDigest?: string;
  neverReached?: boolean;
  writeMayHaveHappened?: boolean;
  publicObjectExists?: boolean;
  statusFlag?: string;
  rearm?: {
    causeFixed: boolean;
    previousDigest: string;
    previousAttemptId: string;
  };
  evidence?: Evidence[];
}

export interface Classification {
  verdict: Verdict;
  mayAutoRetry: false;
  maySecondWrite: false;
  mayRearm: boolean;
  retryLaw: RetryLaw;
  destinationId: string | null;
  summary: string;
}

export interface DestinationObservation {
  destinationId: string;
  packageDigest: string;
  evidence: Evidence[];
}

export interface SurfaceDef {
  name: string;
  idPattern: RegExp;
  /** Called by integrations, never by classify, record, bind, or verify. */
  observe?: (write: OutwardWrite) => DestinationObservation | Promise<DestinationObservation>;
}

export type AuditEvent = "attempt" | "classification" | "observation" | "binding";

export interface AuditEntry extends OutwardWrite {
  id: string;
  timestamp: string;
  verdict: Verdict;
  event: AuditEvent;
  evidence: Evidence[];
}

/**
 * Synchronous backend contract. read must return detached entries in append
 * order. append must never overwrite and must atomically compare expectedLength
 * when supplied, throwing audit_conflict on mismatch. An async backend needs a
 * separate async API; returning a Promise here is a contract violation.
 */
export interface AuditStore {
  read(): readonly AuditEntry[];
  append(entry: AuditEntry, expectedLength?: number): void;
}

export interface Binding {
  destinationId: string;
  packageDigest: string;
  surface: string;
  attemptId: string;
  observationId: string;
  auditEntryId: string;
  timestamp: string;
}

export class ReceiptsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ReceiptsError";
  }
}
