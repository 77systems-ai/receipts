import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assessCertification, evaluationDigest, seededIdentity, type EvaluationReceipt } from "../src/index.js";

function run(mode = "pass", seed = "evaluation-test-seed") {
  const path = join(mkdtempSync(join(tmpdir(), "receipts-evaluation-")), "evaluation.json");
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", fileURLToPath(new URL("./fixtures/evaluation-runner.ts", import.meta.url))], {
    encoding: "utf8", env: { ...childEnvironment, EVALUATION_TEST_MODE: mode, EVALUATION_TEST_OUTPUT: path, EVALUATION_TEST_SEED: seed },
  });
  assert.equal(result.error, undefined);
  const text = readFileSync(path, "utf8");
  return { receipt: JSON.parse(text) as EvaluationReceipt, text, result,
    identities: JSON.parse(readFileSync(`${path}.ids`, "utf8")) as string[] };
}

test("every run emits benchmark, version, environment, cases, and decision-level calibration", () => {
  const { receipt, result } = run();
  assert.equal(result.status, 0);
  assert.deepEqual(receipt.benchmark, { name: "receipts-connector-conformance", version: "2.0.0" });
  assert.equal(receipt.connector.version, "0.3.0");
  assert.deepEqual(Object.keys(receipt.provenance.environment).sort(), ["arch", "node", "platform"]);
  assert.equal(receipt.provenance.authority, "self-attested");
  assert.equal(receipt.cases.length, 7);
  assert.deepEqual(receipt.calibration.falseComplete, { errors: 0, denominator: 6, planned: 6, unobserved: 0, rate: 0 });
  assert.deepEqual(receipt.calibration.falseBlock, { errors: 0, denominator: 4, planned: 4, unobserved: 0, rate: 0 });
  assert.deepEqual(receipt.calibration.unsafeDispatch, { errors: 0, denominator: 3, planned: 3, unobserved: 0, rate: 0 });
  assert.equal(receipt.summary.conforms, true);
  assert.equal(receipt.cases.find(item => item.name === "forged-evidence")!.decisions[0]!.observed, "reject");
});

test("the seed determines case IDs and real action identities and identical runs are reproducible", () => {
  const first = run();
  const second = run();
  assert.equal(first.text, second.text);
  assert.deepEqual(first.identities, second.identities);
  assert.equal(first.identities[0], seededIdentity("evaluation-test-seed", "lost-response", "identity-0"));
  const other = run("pass", "a-different-seed");
  assert.notDeepEqual(first.identities, other.identities);
  assert.notEqual(first.receipt.cases[0]!.id, other.receipt.cases[0]!.id);
});

test("failing cases are all retained with sanitized failure codes and unobserved denominators", () => {
  const { receipt, text, result } = run("setup-failure");
  assert.notEqual(result.status, 0);
  assert.equal(receipt.cases.length, 7);
  assert.equal(receipt.summary.failed, 7);
  assert.equal(receipt.summary.complete, false);
  assert.equal(receipt.calibration.falseComplete.denominator, 0);
  assert.equal(receipt.calibration.falseComplete.unobserved, 6);
  assert.equal(receipt.calibration.falseComplete.rate, null);
  assert.ok(receipt.cases.every(item => item.failureCode === "fixture_or_operation_failed"));
  for (const output of [text, result.stdout, result.stderr]) assert.doesNotMatch(output, /sensitive-error-content|private-payload-never-emit/);
});

test("edited objects produce measured false-complete errors instead of only a failed test count", () => {
  const { receipt, result } = run("false-complete");
  assert.notEqual(result.status, 0);
  const edited = receipt.cases.find(item => item.name === "changed-content")!;
  assert.equal(edited.status, "failed");
  assert.equal(edited.decisions[0]!.observed, "accept");
  assert.ok(receipt.calibration.falseComplete.errors >= 1);
  assert.ok(receipt.calibration.falseComplete.denominator >= 1);
  assert.ok(receipt.calibration.falseComplete.rate! > 0);
  assert.equal(receipt.summary.conforms, false);
});

test("a refused legitimate recovery contributes to the false-block denominator", () => {
  const { receipt, result } = run("false-block");
  assert.notEqual(result.status, 0);
  const recovery = receipt.cases.find(item => item.name === "lost-response")!.decisions.find(item => item.name === "recovered-completion")!;
  assert.equal(recovery.observed, "reject");
  assert.ok(receipt.calibration.falseBlock.errors >= 1);
  assert.ok(receipt.calibration.falseBlock.denominator >= 1);
  assert.ok(receipt.calibration.falseBlock.rate! > 0);
});

test("certification requires a matching publication declaration and rejects failing or incomplete reports", () => {
  const { receipt } = run();
  assert.equal(assessCertification(receipt).eligible, false);
  const publication = { url: "https://example.com/evaluations/github-0.3.0.json", digest: evaluationDigest(receipt) };
  const valid = assessCertification(receipt, publication);
  assert.equal(valid.eligible, true);
  assert.equal(valid.publicationDeclared, true);
  assert.equal(valid.publicationVerified, false);
  assert.equal(assessCertification(receipt, { ...publication, digest: `sha256:${"0".repeat(64)}` }).eligible, false);
  for (const modified of [
    { ...receipt, cases: receipt.cases.slice(0, 1) },
    { ...receipt, cases: receipt.cases.map((item, index) => index ? item : { ...item, status: "failed" as const }) },
    { ...receipt, connector: { ...receipt.connector, version: "unspecified" } },
  ]) assert.equal(assessCertification(modified, { ...publication, digest: evaluationDigest(modified) }).eligible, false);
});
