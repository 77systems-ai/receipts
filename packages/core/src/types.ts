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

export type AuditEvent = "attempt" | "classification" | "observation" | "binding" | "recheck"
  | "claim" | "claim_expired" | "claim_released" | "claim_completed" | "policy_denied" | "duplicate";

export type AdmissionVerdict = "CLAIMED" | "AUTHORIZED" | "DUPLICATE" | "policy_denied" | "RELEASED" | "COMPLETED" | "EXPIRED";

export interface RegistryAudit {
  leaseId: string;
  tokenHash: string;
  fence: number;
  expiresAt: string;
}

export interface AdmissionAudit {
  verdict: AdmissionVerdict;
  ruleId?: string;
  reason?: "active_claim" | "completed" | "dispatched" | "approval_reused";
}

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
  registry?: RegistryAudit;
  admission?: AdmissionAudit;
}

export interface AuditEnvelope {
  version: 1;
  sequence: number;
  previousHash: string | null;
  entry: AuditEntry;
  hash: string;
}

export interface AuditChain {
  envelopes: AuditEnvelope[];
  head: { count: number; hash: string | null };
}

export interface ApprovedAction {
  surface: string;
  attemptId: string;
  actionId: string;
  destinationAccount: string;
  approvalId: string;
  packageDigest: string;
  idempotencyKey?: string;
}

export interface ClaimLease extends ApprovedAction {
  leaseId: string;
  token: string;
  fence: number;
  expiresAt: string;
}

export interface AdmissionDecision {
  verdict: AdmissionVerdict;
  auditEntryId: string;
  ruleId?: string;
  reason?: AdmissionAudit["reason"];
}

export type ClaimDecision = (AdmissionDecision & { verdict: "CLAIMED"; claim: ClaimLease })
  | (AdmissionDecision & { verdict: "DUPLICATE" });

/** A durable refusal recorded before any reservation existed. It holds no lease and consumes no budget. */
export type PolicyDeniedDecision = AdmissionDecision & { verdict: "policy_denied"; ruleId: string };

/** Pure policy result. `allowed` is not a reservation; only claim and dispatch change durable state. */
export type PolicyEvaluation = { verdict: "allowed" } | { verdict: "policy_denied"; ruleId: string };

export interface PolicyRule {
  id: string;
  effect: "allow" | "block";
  surface?: string;
  destinationAccount?: string;
}

export interface RateLimitRule {
  id: string;
  maxWrites: number;
  windowMs: number;
  surface?: string;
  destinationAccount?: string;
}

export interface WritePolicy {
  defaultEffect?: "allow" | "block";
  rules?: readonly PolicyRule[];
  rateLimits?: readonly RateLimitRule[];
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
