import { createHash } from "node:crypto";
import { getSurface } from "./registry.js";
import { ReceiptsError, type Classification, type Evidence, type OutwardWrite } from "./types.js";

export function digestPackage(payload: string | Uint8Array): string {
  if (typeof payload !== "string" && !(payload instanceof Uint8Array)) {
    throw new ReceiptsError("invalid_payload", "Digest exact UTF-8 text or bytes; serialize structured payloads first.");
  }
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function validateDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ReceiptsError("invalid_digest", "Package identity must be a lowercase sha256 content digest.");
  }
}

export function validateEvidence(evidence: unknown): asserts evidence is Evidence[] {
  if (!Array.isArray(evidence)) throw new ReceiptsError("invalid_evidence", "Evidence must be an array.");
  for (const item of evidence) {
    if (!item || !["provider", "human", "executor", "binding"].includes(item.source)
      || typeof item.detail !== "string" || !item.detail.trim()) {
      throw new ReceiptsError("invalid_evidence", "Evidence needs a recognized source and a nonempty detail.");
    }
    for (const key of ["observedAt", "destinationId", "reference"] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || !item[key].trim())) {
        throw new ReceiptsError("invalid_evidence", `Evidence ${key} must be a nonempty string.`);
      }
    }
    if (item.observedAt !== undefined && !Number.isFinite(Date.parse(item.observedAt))) {
      throw new ReceiptsError("invalid_evidence", "Evidence observedAt must be a timestamp.");
    }
    if (item.packageDigest !== undefined) validateDigest(item.packageDigest);
    if (item.detailDigest !== undefined) validateDigest(item.detailDigest);
    if (item.referenceDigest !== undefined) validateDigest(item.referenceDigest);
  }
}

export function validateWrite(write: OutwardWrite): void {
  if (!write || typeof write !== "object") throw new ReceiptsError("invalid_write", "An outward write is required.");
  const surface = getSurface(write.surface);
  validateDigest(write.packageDigest);
  if (write.actionId !== undefined && (typeof write.actionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(write.actionId))) {
    throw new ReceiptsError("invalid_action_id", "actionId must be a caller-supplied UUID.");
  }
  for (const key of ["destinationAccount", "approvalId"] as const) {
    if (write[key] !== undefined && (typeof write[key] !== "string" || !write[key].trim()
      || write[key] !== write[key].trim() || write[key].length > 256 || /[\u0000-\u001f\u007f]/.test(write[key]))) {
      throw new ReceiptsError("invalid_write", `${key} must be a bounded identifier without surrounding whitespace or control characters.`);
    }
  }
  if (typeof write.attemptId !== "string" || !write.attemptId.trim()) {
    throw new ReceiptsError("invalid_write", "A nonempty attemptId is required.");
  }
  for (const key of ["idempotencyKey", "statusFlag"] as const) {
    if (write[key] !== undefined && (typeof write[key] !== "string" || !write[key].trim())) {
      throw new ReceiptsError("invalid_write", `${key} must be a nonempty string.`);
    }
  }
  for (const key of ["neverReached", "writeMayHaveHappened", "publicObjectExists"] as const) {
    if (write[key] !== undefined && typeof write[key] !== "boolean") {
      throw new ReceiptsError("invalid_write", `${key} must be a boolean.`);
    }
  }
  if (write.destinationId !== undefined && (typeof write.destinationId !== "string"
    || !write.destinationId.trim() || write.destinationId !== write.destinationId.trim()
    || !surface.idPattern.test(write.destinationId))) {
    throw new ReceiptsError("invalid_destination_id", `Destination ID does not match surface ${write.surface}.`);
  }
  if (write.boundPackageDigest !== undefined) validateDigest(write.boundPackageDigest);
  if (write.evidence !== undefined) validateEvidence(write.evidence);
  if (write.rearm !== undefined) {
    if (!write.rearm || typeof write.rearm.causeFixed !== "boolean"
      || typeof write.rearm.previousAttemptId !== "string" || !write.rearm.previousAttemptId.trim()) {
      throw new ReceiptsError("invalid_rearm", "Rearm requires causeFixed and the previous attempt ID.");
    }
    validateDigest(write.rearm.previousDigest);
  }
}

function canRearm(write: OutwardWrite): boolean {
  return write.neverReached === true && write.rearm?.causeFixed === true
    && write.rearm.previousDigest !== write.packageDigest
    && write.rearm.previousAttemptId !== write.attemptId;
}

/** Pure: no destination reads, clock reads, file reads, or mutations. */
export function classify(write: OutwardWrite): Classification {
  validateWrite(write);
  const base = { mayAutoRetry: false as const, maySecondWrite: false as const, mayRearm: false,
    destinationId: write.destinationId ?? null };
  if (write.destinationId && write.boundPackageDigest === write.packageDigest) {
    return { ...base, verdict: "complete", retryLaw: "none", summary: "The destination ID is bound to the approved package digest." };
  }
  if (write.writeMayHaveHappened === true) {
    return { ...base, verdict: "delivery_unknown", retryLaw: "never_auto_retry", summary: "A write may have happened. Observe the destination; never retry or create a second write." };
  }
  if (write.destinationId || write.publicObjectExists === true) {
    return { ...base, verdict: "package_unverified", retryLaw: "never_second_post", summary: "An object exists without a verified package binding. Bind the existing object; never create another." };
  }
  return { ...base, verdict: "prewrite", retryLaw: "rearm_after_fix", mayRearm: canRearm(write),
    summary: write.neverReached === true
      ? "The destination was never reached. Rearm only with a fixed cause, a new digest, and a new attempt."
      : "No destination evidence is available. Rearming requires affirmative evidence that the destination was never reached." };
}

export function mayRearmPrewrite(write: OutwardWrite): boolean {
  return classify(write).mayRearm;
}
