import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CONFORMANCE_BENCHMARK = Object.freeze({ name: "receipts-connector-conformance", version: "2.0.0" });
export const BENCHMARK_CASES = [
  { name: "lost-response", decisions: [["uncertain-completion", "false-complete"], ["duplicate-dispatch", "unsafe-dispatch"], ["recovered-completion", "false-block"]] },
  { name: "wrong-account", decisions: [["wrong-account-completion", "false-complete"]] },
  { name: "changed-content", decisions: [["edited-completion", "false-complete"]] },
  { name: "timeout", decisions: [["timeout-completion", "false-complete"], ["timeout-duplicate-dispatch", "unsafe-dispatch"]] },
  { name: "forged-evidence", decisions: [["forged-independent-completion", "false-complete"]] },
  { name: "reapproved-content", decisions: [["recycled-approval-dispatch", "unsafe-dispatch"], ["new-approval-dispatch", "false-block"]] },
  { name: "recheck-history", decisions: [["unchanged-recheck-completion", "false-block"], ["edited-recheck-completion", "false-complete"], ["historical-completion", "false-block"]] },
] as const;

export type CalibrationKind = "false-complete" | "false-block" | "unsafe-dispatch";
export interface DecisionResult {
  name: string;
  kind: CalibrationKind;
  /** Accept means the specific decision named here was permitted, not necessarily a destination write. */
  expected: "accept" | "reject";
  observed: "accept" | "reject" | "unobserved";
}
export interface CaseResult {
  id: string;
  name: string;
  status: "passed" | "failed" | "not-run";
  failureCode?: "assertion_failed" | "fixture_or_operation_failed" | "cleanup_failed";
  decisions: DecisionResult[];
}
export interface CalibrationRate {
  errors: number;
  denominator: number;
  planned: number;
  unobserved: number;
  rate: number | null;
}
export interface EvaluationReceipt {
  schemaVersion: "receipts-evaluation-v1";
  benchmark: { name: string; version: string };
  connector: { name: string; version: string };
  provenance: {
    environment: { node: string; platform: string; arch: string };
    seed: string;
    idGeneration: "sha256-seed-case-purpose-v1";
    execution: "local-controlled-fixture";
    authority: "self-attested";
  };
  cases: CaseResult[];
  calibration: { falseComplete: CalibrationRate; falseBlock: CalibrationRate; unsafeDispatch: CalibrationRate };
  summary: { passed: number; failed: number; notRun: number; complete: boolean; conforms: boolean };
}
export interface ConformanceOptions {
  /** Supply the real connector package version. Unknown versions cannot qualify for certification. */
  connectorVersion?: string;
  seed?: string;
  /** Defaults to .receipts/evaluations/<connector>-<seeded-id>.json. */
  evaluationPath?: string;
  /** Explicit sink replaces the default file; when a path is also supplied, both receive the receipt. */
  onEvaluation?: (receipt: EvaluationReceipt) => void | Promise<void>;
}
export interface EvaluationPublication {
  /** URL of the already-published exact JSON receipt. No request is made to this URL. */
  url: string;
  digest: string;
}

function label(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} must be a nonempty bounded identifier without control characters.`);
  }
  return value;
}

/** Stable identities are derived from the seed and purpose, never from randomUUID. */
export function seededIdentity(seed: string, caseName: string, purpose: string): string {
  const bytes = createHash("sha256").update(JSON.stringify([seed, caseName, purpose])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function initialCaseResults(seed: string): CaseResult[] {
  return BENCHMARK_CASES.map((item) => ({ id: seededIdentity(seed, item.name, "case"), name: item.name,
    status: "not-run", decisions: item.decisions.map(([name, kind]) => ({ name, kind,
      expected: kind === "false-block" ? "accept" : "reject", observed: "unobserved" })) }));
}
function matchesBenchmark(cases: readonly CaseResult[], seed: string): boolean {
  const shape = (items: readonly CaseResult[]) => items.map((item) => ({ id: item.id, name: item.name,
    decisions: item.decisions.map(({ name, kind, expected }) => ({ name, kind, expected })) }));
  return JSON.stringify(shape(cases)) === JSON.stringify(shape(initialCaseResults(seed)));
}

function rate(cases: readonly CaseResult[], kind: CalibrationKind): CalibrationRate {
  const decisions = cases.flatMap((item) => item.decisions).filter((item) => item.kind === kind);
  const evaluated = decisions.filter((item) => item.observed !== "unobserved");
  const errors = evaluated.filter((item) => item.observed !== item.expected).length;
  return { errors, denominator: evaluated.length, planned: decisions.length,
    unobserved: decisions.length - evaluated.length, rate: evaluated.length ? errors / evaluated.length : null };
}

export function buildEvaluationReceipt(name: string, options: ConformanceOptions, cases: readonly CaseResult[]): EvaluationReceipt {
  const seed = label(options.seed ?? "receipts-conformance-v2", "seed");
  const falseComplete = rate(cases, "false-complete");
  const falseBlock = rate(cases, "false-block");
  const unsafeDispatch = rate(cases, "unsafe-dispatch");
  const passed = cases.filter((item) => item.status === "passed").length;
  const failed = cases.filter((item) => item.status === "failed").length;
  const notRun = cases.filter((item) => item.status === "not-run").length;
  const complete = matchesBenchmark(cases, seed) && cases.every((item) => item.status === "passed" || item.status === "failed") && notRun === 0 && falseComplete.unobserved === 0 && falseBlock.unobserved === 0 && unsafeDispatch.unobserved === 0;
  return {
    schemaVersion: "receipts-evaluation-v1", benchmark: { ...CONFORMANCE_BENCHMARK },
    connector: { name: label(name, "connector name"), version: label(options.connectorVersion ?? "unspecified", "connector version") },
    provenance: { environment: { node: process.versions.node, platform: process.platform, arch: process.arch },
      seed, idGeneration: "sha256-seed-case-purpose-v1", execution: "local-controlled-fixture", authority: "self-attested" },
    cases: structuredClone([...cases]), calibration: { falseComplete, falseBlock, unsafeDispatch },
    summary: { passed, failed, notRun, complete, conforms: complete && passed === cases.length && failed === 0 && falseComplete.errors === 0 && falseBlock.errors === 0 && unsafeDispatch.errors === 0 },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function evaluationDigest(receipt: EvaluationReceipt): string {
  return `sha256:${createHash("sha256").update(canonical(receipt)).digest("hex")}`;
}

export async function emitEvaluation(receipt: EvaluationReceipt, options: ConformanceOptions): Promise<void> {
  const path = options.evaluationPath ?? (!options.onEvaluation
    ? `.receipts/evaluations/${receipt.connector.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${seededIdentity(receipt.provenance.seed, receipt.connector.name, receipt.connector.version)}.json`
    : undefined);
  if (path) {
    const destination = resolve(path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }
  if (options.onEvaluation) await options.onEvaluation(structuredClone(receipt));
}

/** Local eligibility only. Publication is explicitly declared, never remotely verified. */
export function assessCertification(receipt: EvaluationReceipt, publication?: EvaluationPublication): {
  eligible: boolean; publicationDeclared: boolean; publicationVerified: false; evaluationDigest: string; reasons: string[];
} {
  const reasons: string[] = [];
  const digest = evaluationDigest(receipt);
  const recomputed = buildEvaluationReceipt(receipt.connector.name, {
    seed: receipt.provenance.seed, connectorVersion: receipt.connector.version,
  }, receipt.cases);
  if (receipt.schemaVersion !== "receipts-evaluation-v1" || receipt.provenance.execution !== "local-controlled-fixture" ||
    receipt.provenance.authority !== "self-attested" || receipt.provenance.idGeneration !== "sha256-seed-case-purpose-v1") reasons.push("invalid_evaluation_provenance");
  if (receipt.benchmark.name !== CONFORMANCE_BENCHMARK.name || receipt.benchmark.version !== CONFORMANCE_BENCHMARK.version) reasons.push("unsupported_benchmark");
  if (receipt.connector.version === "unspecified") reasons.push("connector_version_required");
  if (!recomputed.summary.complete || !recomputed.summary.conforms || !receipt.summary.conforms ||
    canonical(recomputed.calibration) !== canonical(receipt.calibration) || canonical(recomputed.summary) !== canonical(receipt.summary)) reasons.push("evaluation_not_conformant");
  let publicationDeclared = false;
  if (publication) {
    try {
      const url = new URL(publication.url);
      publicationDeclared = url.protocol === "https:" && !url.username && !url.password &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && publication.digest === digest;
    } catch { /* Invalid declarations cannot qualify. */ }
  }
  if (!publicationDeclared) reasons.push("published_evaluation_declaration_required");
  return { eligible: reasons.length === 0, publicationDeclared, publicationVerified: false, evaluationDigest: digest, reasons };
}
