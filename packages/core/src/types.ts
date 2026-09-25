export type Verdict = "prewrite" | "delivery_unknown" | "package_unverified" | "complete";
export type RetryLaw = "rearm_after_fix" | "never_auto_retry" | "never_second_post" | "none";

export type EvidenceSource = "host-supplied" | "receipts-read";

/** Caller claims stay cooperative. Only core-executed connector reads are independent. */
export interface Evidence {
  source: "provider" | "human" | "executor" | "binding";
  detail: string;
  observedAt?: string;
  destinationId?: string;
  packageDigest?: string;
  reference?: string;
  detailDigest?: string;
  referenceDigest?: string;
}

/**
 * Normalized, trusted input. Supplying boundPackageDigest to the pure classifier
 * describes a binding; it does not create a durable receipt. Use bind + verify
 * for audited completion. Observe callbacks must read back the actual payload.
 */
export interface OutwardWrite {
  surface: string;
  attemptId: string;
  /** Required for new durable audit entries; optional for legacy pure classifications. */
  actionId?: string;
  destinationAccount?: string;
  approvalId?: string;
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

export type AuditEvent = "attempt" | "classification" | "observation" | "binding" | "recheck";

export interface AuditEntry extends OutwardWrite {
  id: string;
  timestamp: string;
  verdict: Verdict;
  event: AuditEvent;
  evidence: Evidence[];
  evidenceSource?: EvidenceSource;
  independentlyVerified?: boolean;
  observedAt?: string;
  observedPackageDigest?: string;
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
  actionId: string;
  destinationAccount: string;
  approvalId: string;
  evidenceSource: EvidenceSource;
  independentlyVerified: boolean;
  observedAt: string;
}

export interface Receipt extends Binding {
  verdict: Verdict;
  observedPackageDigest?: string;
}

export interface ReceiptScope {
  destinationAccount?: string;
  actionId?: string;
  surface?: string;
  attemptId?: string;
}

export interface ConnectorRequest {
  surface: string;
  attemptId: string;
  actionId: string;
  destinationAccount: string;
  approvalId: string;
  packageDigest: string;
  destinationId?: string;
  /** Provider lookup input; never copied to the audit. */
  locator?: Record<string, string | number>;
  recheck?: boolean;
}

export interface ConnectorObservation {
  destinationAccount: string;
  destinationId: string;
  packageDigest: string;
  observedAt: string;
}

/** Trusted local executable configuration, never deserialized from a tool request. */
export interface DestinationConnector {
  surface: string;
  read(request: ConnectorRequest): ConnectorObservation | Promise<ConnectorObservation>;
}

export type TrustedConnector = DestinationConnector;

export class ReceiptsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ReceiptsError";
  }
}
