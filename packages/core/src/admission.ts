import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { createAuditEntry, getDefaultStore, readAuditEntries, recordAdmission } from "./audit.js";
import { digestPackage } from "./classify.js";
import { getSurface } from "./registry.js";
import {
  ReceiptsError, type AdmissionDecision, type ApprovedAction, type AuditEntry, type AuditStore,
  type ClaimDecision, type ClaimLease, type PolicyDeniedDecision, type PolicyEvaluation, type RegistryAudit, type WritePolicy,
} from "./types.js";

export interface IdempotencyRegistryOptions {
  store?: AuditStore;
  /** Only unused reservations expire. Dispatch permanently disables TTL retry. */
  ttlMs?: number;
  /** Local clock override for deterministic tests; production uses Date.now. */
  now?: () => number;
}

const retrySignal = new Int32Array(new SharedArrayBuffer(4));
const ruleIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const lifecycleEvents = new Set(["claim", "attempt", "claim_expired", "claim_released", "claim_completed"]);

/**
 * Action identity is the exact account plus the caller's UUID. RFC 9562 defines UUID
 * hexadecimal as case-insensitive, and hosts legitimately emit either case for the same
 * identifier, so the UUID alone is canonicalized to lowercase. Every other identity
 * field (account, approval, attempt, digest) is an opaque string compared exactly;
 * see sameIdentity. Do not "fix" this asymmetry: uppercase UUIDs must not evade the
 * duplicate guard, and accounts must never be folded because providers may be case-aware.
 */
function sameAction(entry: ApprovedAction | AuditEntry, action: ApprovedAction): boolean {
  return entry.destinationAccount === action.destinationAccount && entry.actionId?.toLowerCase() === action.actionId.toLowerCase();
}
function sameIdentity(entry: ApprovedAction | AuditEntry, action: ApprovedAction): boolean {
  return sameAction(entry, action) && entry.surface === action.surface && entry.attemptId === action.attemptId
    && entry.packageDigest === action.packageDigest && entry.approvalId === action.approvalId;
}
function identity(action: ApprovedAction): ApprovedAction {
  // An explicit allowlist prevents payload/credential properties entering claim data.
  const result: ApprovedAction = { surface: action.surface, attemptId: action.attemptId, actionId: action.actionId,
    destinationAccount: action.destinationAccount, approvalId: action.approvalId, packageDigest: action.packageDigest,
    ...(action.idempotencyKey !== undefined ? { idempotencyKey: action.idempotencyKey } : {}) };
  createAuditEntry(result); // Same UUID/scope validation as every durable core write.
  return result;
}
function currentLease(entries: readonly AuditEntry[], action: ApprovedAction): AuditEntry | undefined {
  return entries.filter((entry) => sameAction(entry, action) && entry.registry && lifecycleEvents.has(entry.event)).at(-1);
}
function isPossibleWrite(entry: AuditEntry): boolean {
  return entry.event === "attempt" || entry.writeMayHaveHappened === true || entry.destinationId !== undefined;
}
/**
 * An approval authorizes exactly one action on its account. It is spent by any other
 * action that may have written, or that holds a live (unexpired, unreleased) reservation:
 * two live reservations under one approval could both dispatch. A reservation that was
 * released or has expired unused never reached the destination, so it does not spend the
 * approval; refusals (duplicate, pre-claim policy denials) never spend it either.
 */
function approvalConsumed(entries: readonly AuditEntry[], action: ApprovedAction, now: number): boolean {
  const others = entries.filter((entry) => entry.destinationAccount === action.destinationAccount && entry.approvalId === action.approvalId
    && entry.actionId !== undefined && entry.actionId.toLowerCase() !== action.actionId.toLowerCase());
  if (others.some(isPossibleWrite)) return true;
  return [...new Set(others.map((entry) => entry.actionId!.toLowerCase()))].some((actionId) => {
    const current = currentLease(entries, { ...action, actionId });
    return current?.event === "claim" && Date.parse(current.registry!.expiresAt) > now;
  });
}
function decision(entry: AuditEntry): AdmissionDecision {
  return { verdict: entry.admission!.verdict, auditEntryId: entry.id,
    ...(entry.admission!.ruleId ? { ruleId: entry.admission!.ruleId } : {}),
    ...(entry.admission!.reason ? { reason: entry.admission!.reason } : {}) };
}
function leaseMetadata(lease: ClaimLease): RegistryAudit {
  return { leaseId: lease.leaseId, tokenHash: digestPackage(lease.token), fence: lease.fence, expiresAt: lease.expiresAt };
}
function matchScope(rule: { surface?: string; destinationAccount?: string }, action: ApprovedAction | AuditEntry): boolean {
  return (rule.surface === undefined || rule.surface === action.surface)
    && (rule.destinationAccount === undefined || rule.destinationAccount === action.destinationAccount);
}

/** Structural validation of host-owned policy configuration. Throws invalid_policy; evaluates nothing. */
export function validatePolicy(policy: WritePolicy = {}): void {
  if (!policy || typeof policy !== "object" || (policy.defaultEffect !== undefined && !["allow", "block"].includes(policy.defaultEffect))
    || (policy.rules !== undefined && !Array.isArray(policy.rules)) || (policy.rateLimits !== undefined && !Array.isArray(policy.rateLimits))) {
    throw new ReceiptsError("invalid_policy", "Policy rules and rate limits must be explicit arrays.");
  }
  const ids = new Set<string>();
  for (const rule of [...policy.rules ?? [], ...policy.rateLimits ?? []]) {
    if (!rule || typeof rule.id !== "string" || !ruleIdPattern.test(rule.id) || ids.has(rule.id)) {
      throw new ReceiptsError("invalid_policy", "Policy rule IDs must be unique opaque identifiers.");
    }
    ids.add(rule.id);
    if (rule.surface !== undefined) getSurface(rule.surface);
    if (rule.destinationAccount !== undefined && (typeof rule.destinationAccount !== "string" || !rule.destinationAccount.trim()
      || rule.destinationAccount !== rule.destinationAccount.trim())) throw new ReceiptsError("invalid_policy", "Policy accounts must be exact identifiers.");
  }
  for (const rule of policy.rules ?? []) {
    if (rule.effect !== "allow" && rule.effect !== "block") throw new ReceiptsError("invalid_policy", "A rule effect must be allow or block.");
  }
  for (const rule of policy.rateLimits ?? []) {
    if (!Number.isSafeInteger(rule.maxWrites) || rule.maxWrites < 0 || !Number.isSafeInteger(rule.windowMs) || rule.windowMs < 1) {
      throw new ReceiptsError("invalid_policy", "Rate limits require a nonnegative write budget and a positive window in milliseconds.");
    }
  }
}

/** Policy evaluation creates no audit mutation. Budget is consumed only by durable dispatch. */
export function evaluatePolicy(action: ApprovedAction, policy: WritePolicy = {}, entries: readonly AuditEntry[] = [], now = Date.now()): PolicyEvaluation {
  getSurface(action.surface);
  validatePolicy(policy);
  const block = policy.rules?.find((rule) => rule.effect === "block" && matchScope(rule, action));
  if (block) return { verdict: "policy_denied", ruleId: block.id };
  if (policy.defaultEffect === "block" && !policy.rules?.some((rule) => rule.effect === "allow" && matchScope(rule, action))) {
    return { verdict: "policy_denied", ruleId: "default-policy" };
  }
  for (const rule of policy.rateLimits ?? []) {
    if (!matchScope(rule, action)) continue;
    // Future timestamps count conservatively after local clock rollback.
    const used = entries.filter((entry) => entry.event === "attempt" && matchScope(rule, entry)
      && Date.parse(entry.timestamp) > now - rule.windowMs).length;
    if (used >= rule.maxWrites) return { verdict: "policy_denied", ruleId: rule.id };
  }
  return { verdict: "allowed" };
}

/** Durable claim leases with atomic dispatch, policy budgets, and stale-owner fencing. */
export class IdempotencyRegistry {
  readonly store: AuditStore;
  readonly ttlMs: number;
  readonly #now: () => number;

  constructor(options: IdempotencyRegistryOptions = {}) {
    this.store = options.store ?? getDefaultStore();
    this.ttlMs = options.ttlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 30 * 24 * 60 * 60 * 1000) {
      throw new ReceiptsError("invalid_claim_ttl", "Claim TTL must be between 1 millisecond and 30 days.");
    }
    if (typeof this.#now !== "function") throw new ReceiptsError("invalid_clock", "The registry clock must be a function.");
  }

  #atomic<T>(operation: (entries: readonly AuditEntry[], now: number) => T): T {
    for (let retry = 0; retry < 100; retry++) {
      try {
        const entries = readAuditEntries(this.store);
        const now = this.#now();
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).valueOf())) throw new ReceiptsError("invalid_clock", "The registry clock must return a valid Unix timestamp in milliseconds.");
        return operation(entries, now);
      } catch (error) {
        if (!(error instanceof ReceiptsError) || !["audit_locked", "audit_conflict"].includes(error.code)) throw error;
        if (retry === 99) throw new ReceiptsError("audit_busy", "Registry contention did not settle; no write is authorized.");
        // Bounded, synchronous backoff also coordinates separate Node processes.
        Atomics.wait(retrySignal, 0, 0, Math.min(20, retry + 1));
      }
    }
    throw new ReceiptsError("audit_busy", "Registry contention did not settle; no write is authorized.");
  }

  #entry(action: ApprovedAction, now: number, event: AuditEntry["event"], admission: NonNullable<AuditEntry["admission"]>, registry?: RegistryAudit): AuditEntry {
    const entry = createAuditEntry(identity(action));
    entry.timestamp = new Date(now).toISOString();
    entry.event = event;
    entry.admission = admission;
    if (registry) entry.registry = registry;
    return entry;
  }

  /**
   * Reserve an approved action. Without a policy the decision is purely about identity.
   * With the host's policy, a forbidden write is refused before any reservation exists
   * (one audited `policy_denied` record, no lease, no budget). Dispatch re-evaluates the
   * same policy because shared budgets can be consumed between claim and dispatch; the
   * dispatch check is the enforcement boundary, this one is early feedback.
   */
  claim(input: ApprovedAction): ClaimDecision;
  claim(input: ApprovedAction, policy: WritePolicy): ClaimDecision | PolicyDeniedDecision;
  claim(input: ApprovedAction, policy?: WritePolicy): ClaimDecision | PolicyDeniedDecision {
    const action = identity(input);
    if (policy !== undefined) validatePolicy(policy);
    return this.#atomic((entries, now) => {
      const actionEntries = entries.filter((entry) => sameAction(entry, action));
      const current = currentLease(entries, action);
      let reason: "active_claim" | "completed" | "dispatched" | "approval_reused" | undefined;
      if (actionEntries.some((entry) => entry.event === "claim_completed" || entry.event === "binding")) reason = "completed";
      else if (actionEntries.some(isPossibleWrite)) reason = "dispatched";
      else if (approvalConsumed(entries, action, now)) reason = "approval_reused";
      else if (current?.event === "claim" && Date.parse(current.registry!.expiresAt) > now) reason = "active_claim";
      if (reason) {
        // Refusal is a separate decision record, never an amendment to the
        // original attempt when the caller changed payload or idempotency data.
        const entry = this.#entry({ ...action, attemptId: randomUUID() }, now, "duplicate", { verdict: "DUPLICATE", reason });
        return { ...decision(recordAdmission(entry, this.store, entries.length)), verdict: "DUPLICATE" as const };
      }
      if (current?.event === "claim") {
        const expired = this.#entry(identity(current as ApprovedAction), now, "claim_expired", { verdict: "EXPIRED" }, current.registry);
        recordAdmission(expired, this.store, entries.length);
        // Re-enter with the updated tail. A competitor may win the next append.
        throw new ReceiptsError("audit_conflict", "Lease expired; refresh the registry snapshot before reclaim.");
      }
      if (policy !== undefined) {
        const result = evaluatePolicy(action, policy, entries, now);
        if (result.verdict === "policy_denied") {
          // Identity refusals above take precedence: an existing write must be reconciled
          // regardless of policy. This denial holds no lease, so nothing needs releasing.
          const entry = this.#entry(action, now, "policy_denied", result);
          return { ...decision(recordAdmission(entry, this.store, entries.length)), verdict: "policy_denied" as const, ruleId: result.ruleId };
        }
      }
      const lastFence = Math.max(0, ...actionEntries.map((entry) => entry.registry?.fence ?? 0));
      const claim: ClaimLease = { ...action, leaseId: randomUUID(), token: randomBytes(32).toString("hex"),
        fence: lastFence + 1, expiresAt: new Date(now + this.ttlMs).toISOString() };
      const entry = this.#entry(action, now, "claim", { verdict: "CLAIMED" }, leaseMetadata(claim));
      const recorded = recordAdmission(entry, this.store, entries.length);
      return { verdict: "CLAIMED" as const, claim: Object.freeze(claim), auditEntryId: recorded.id };
    });
  }

  #held(entries: readonly AuditEntry[], lease: ClaimLease): AuditEntry {
    const current = currentLease(entries, lease);
    const suppliedHash = typeof lease.token === "string" ? digestPackage(lease.token) : "";
    if (!current?.registry || !sameIdentity(current, lease) || current.registry.leaseId !== lease.leaseId
      || current.registry.fence !== lease.fence || current.registry.expiresAt !== lease.expiresAt
      || suppliedHash.length !== current.registry.tokenHash.length
      || !timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(current.registry.tokenHash))) {
      throw new ReceiptsError("stale_claim", "This lease is stale or belongs to another owner. No write is authorized.");
    }
    return current;
  }

  #unused(entries: readonly AuditEntry[], lease: ClaimLease, now: number): AuditEntry {
    const current = this.#held(entries, lease);
    if (current.event !== "claim") throw new ReceiptsError("claim_dispatched", "Only an unused reservation can be dispatched or released. Reconcile any possible write.");
    if (Date.parse(current.registry!.expiresAt) <= now) {
      recordAdmission(this.#entry(identity(current as ApprovedAction), now, "claim_expired", { verdict: "EXPIRED" }, current.registry), this.store, entries.length);
      throw new ReceiptsError("claim_expired", "The unused claim expired. Obtain a new fenced claim before dispatch.");
    }
    return current;
  }

  /** Read-only pre-check against the current durable snapshot. Records nothing and consumes no budget. */
  evaluate(input: ApprovedAction, policy: WritePolicy = {}): PolicyEvaluation {
    const action = identity(input);
    validatePolicy(policy);
    return this.#atomic((entries, now) => evaluatePolicy(action, policy, entries, now));
  }

  dispatch(lease: ClaimLease, policy: WritePolicy = {}): AdmissionDecision {
    identity(lease);
    return this.#atomic((entries, now) => {
      const current = this.#unused(entries, lease, now);
      const result = evaluatePolicy(lease, policy, entries, now);
      if (result.verdict === "policy_denied") {
        return decision(recordAdmission(this.#entry(lease, now, "policy_denied", result, current.registry), this.store, entries.length));
      }
      const entry = this.#entry(lease, now, "attempt", { verdict: "AUTHORIZED" }, current.registry);
      entry.writeMayHaveHappened = true;
      entry.neverReached = false;
      entry.verdict = "delivery_unknown";
      return decision(recordAdmission(entry, this.store, entries.length));
    });
  }

  release(lease: ClaimLease): AdmissionDecision {
    identity(lease);
    return this.#atomic((entries, now) => {
      const current = this.#unused(entries, lease, now);
      return decision(recordAdmission(this.#entry(lease, now, "claim_released", { verdict: "RELEASED" }, current.registry), this.store, entries.length));
    });
  }

  complete(lease: ClaimLease, destinationId: string): AdmissionDecision {
    identity(lease);
    return this.#atomic((entries, now) => {
      this.#held(entries, lease);
      return this.#complete(entries, now, lease, destinationId);
    });
  }

  /** Read-back may finish after restart. Existing audited dispatch and binding are authority. */
  completeVerified(input: ApprovedAction, destinationId: string): AdmissionDecision {
    const action = identity(input);
    return this.#atomic((entries, now) => this.#complete(entries, now, action, destinationId));
  }

  #complete(entries: readonly AuditEntry[], now: number, action: ApprovedAction, destinationId: string): AdmissionDecision {
    const current = currentLease(entries, action);
    if (!current?.registry || !sameIdentity(current, action)) throw new ReceiptsError("stale_claim", "No matching dispatched claim exists.");
    if (current.event === "claim_completed") {
      if (current.destinationId !== destinationId) throw new ReceiptsError("object_mismatch", "A completed action cannot switch destination objects.");
      return decision(current);
    }
    if (current.event !== "attempt") throw new ReceiptsError("claim_not_dispatched", "A claim must be durably dispatched before it can complete.");
    const binding = entries.find((entry) => entry.event === "binding" && entry.verdict === "complete"
      && sameIdentity(entry, action) && entry.destinationId === destinationId);
    if (!binding) throw new ReceiptsError("observation_required", "Completion requires an audited binding for the exact action and destination.");
    const entry = this.#entry(action, now, "claim_completed", { verdict: "COMPLETED" }, current.registry);
    entry.destinationId = destinationId;
    entry.boundPackageDigest = action.packageDigest;
    entry.verdict = "complete";
    return decision(recordAdmission(entry, this.store, entries.length));
  }
}

export function createIdempotencyRegistry(options: IdempotencyRegistryOptions = {}): IdempotencyRegistry {
  return new IdempotencyRegistry(options);
}
