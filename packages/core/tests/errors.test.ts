import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, ERROR_DOCS_URL, ERROR_FAMILIES, ERROR_TAXONOMY, describeError, ReceiptsError } from "../src/index.js";
import { renderErrorTaxonomyMarkdown } from "../src/errors.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|mjs|js)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Every way a code reaches a user: thrown, failed, enveloped, or returned as a reason. */
const codePatterns = [
  /ReceiptsError\(\s*["']([a-z_]+)["']/g,
  /\bfail\(\s*["']([a-z_]+)["']/g,
  /\bcode:\s*["']([a-z_]+)["']/g,
  /readonly code = ["']([a-z_]+)["']/g,
  /\breason:\s*["']([a-z_]+)["']/g,
  /reasons\.push\(\s*["']([a-z_]+)["']\s*\)/g,
];

function codesInSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of ["packages"].flatMap((directory) => sourceFiles(join(root, directory))).filter((file) => /[\\/]src[\\/]/.test(file))) {
    const text = readFileSync(file, "utf8");
    for (const pattern of codePatterns) {
      for (const match of text.matchAll(pattern)) {
        const list = found.get(match[1]!) ?? [];
        list.push(file.slice(root.length));
        found.set(match[1]!, list);
      }
    }
  }
  return found;
}

test("every taxonomy entry names its code, family, cause, fix, and a stable documentation anchor", () => {
  for (const [code, entry] of Object.entries(ERROR_TAXONOMY)) {
    assert.match(code, /^[a-z][a-z_]+$/, `${code} must be a snake_case code`);
    assert.equal(entry.code, code);
    assert.ok(Object.hasOwn(ERROR_FAMILIES, entry.family), `${code} has an unknown family`);
    assert.ok(entry.cause.trim().length > 20, `${code} needs a probable cause`);
    assert.ok(entry.fix.trim().length > 20, `${code} needs a suggested fix`);
    assert.equal(entry.docs, `${ERROR_DOCS_URL}#${code}`);
    assert.ok(Object.isFrozen(entry));
    for (const text of [entry.cause, entry.fix]) {
      assert.doesNotMatch(text, /retry the write|resend|post again/i, `${code} must never suggest repeating an uncertain write`);
    }
  }
  assert.ok(Object.isFrozen(ERROR_TAXONOMY));
});

test("no error code exists in source without a taxonomy entry, and no entry is orphaned", () => {
  const found = codesInSource();
  const unmapped = [...found].filter(([code]) => !describeError(code));
  assert.deepEqual(unmapped, [], `Add taxonomy entries for: ${unmapped.map(([code, files]) => `${code} (${[...new Set(files)].join(", ")})`).join("; ")}`);
  // The taxonomy file itself cannot vouch for its own entries; every code must be emitted somewhere else as a literal.
  const sources = sourceFiles(join(root, "packages")).filter((file) => /[\\/]src[\\/]/.test(file) && !file.endsWith("errors.ts")).map((file) => readFileSync(file, "utf8")).join("\n");
  const emittedAsProse = new Set(["adapter_required"]); // Hook feedback text, not a quoted literal.
  const orphaned = Object.keys(ERROR_TAXONOMY).filter((code) => !emittedAsProse.has(code) && !new RegExp(`["'\`]${code}["'\`]`).test(sources));
  assert.deepEqual(orphaned, [], "Taxonomy entries must correspond to codes that appear in source");
  assert.ok(/adapter_required/.test(sources), "the prose allowlist must still exist in source");
  // Codes that are produced through indirection still reach users and must be documented.
  for (const code of ["internal_error", "startup_failed", "adapter_required", "invalid_proof", "assertion_failed", "duplicate_write_refused", "verification_pending"]) {
    assert.ok(describeError(code), `${code} must be documented`);
  }
});

test("docs/ERRORS.md is generated from the taxonomy and is current", () => {
  const rendered = renderErrorTaxonomyMarkdown();
  const written = readFileSync(join(root, "docs", "ERRORS.md"), "utf8");
  assert.equal(written, rendered, "Run `npm run docs:errors` and commit the result.");
  for (const code of Object.keys(ERROR_TAXONOMY)) assert.ok(rendered.includes(`\n### ${code}\n`), `${code} heading missing`);
  assert.doesNotMatch(rendered, /sha256:[a-f0-9]{64}|Bearer |ghp_/, "The taxonomy must not contain example digests or credentials");
});

test("thrown core errors describe themselves through the taxonomy", () => {
  const thrown: ReceiptsError[] = [];
  for (const attempt of [
    () => classify({ surface: "unregistered", attemptId: "a", packageDigest: `sha256:${"a".repeat(64)}` }),
    () => classify({ surface: "http-post", attemptId: "a", packageDigest: "not-a-digest" }),
    () => classify({ surface: "http-post", attemptId: "a", packageDigest: `sha256:${"a".repeat(64)}`, actionId: "nope" }),
  ]) {
    try { attempt(); } catch (error) { thrown.push(error as ReceiptsError); }
  }
  assert.deepEqual(thrown.map((error) => error.code), ["not_a_destination_write", "invalid_digest", "invalid_action_id"]);
  for (const error of thrown) {
    const entry = describeError(error.code)!;
    assert.ok(entry, `${error.code} must be documented`);
    assert.doesNotMatch(entry.cause + entry.fix, /unregistered|not-a-digest|nope/, "Descriptions are static and never echo input");
  }
  assert.equal(describeError("no_such_code"), undefined);
});

test("every ReceiptsError carries the taxonomy's hint and docs link", () => {
  const error = new ReceiptsError("approval_reused", "This approval was spent by another action.");
  assert.match(error.hint!, /^Request a separate approval per write: each approval ID authorizes exactly one action\./);
  assert.equal(error.docs, `${ERROR_DOCS_URL}#approval_reused`);
  assert.equal(new ReceiptsError("no_such_code", "x").hint, undefined);
  assert.match(describeError("package_unverified")!.fix, /bytes written differ from the claimed bytes: claim from the staged file instead of re-authoring the content/);
  for (const verdict of ["delivery_unknown", "package_unverified", "prewrite"]) assert.equal(describeError(verdict)?.family, "verdict");
  assert.equal(describeError("complete"), undefined, "a complete verdict needs no corrective action");
});

test("every entry's fix opens with what to do, not a restatement of the failure", () => {
  const openers = /^(Do not|Nothing|Request|Serialize|Add|Re-read|Inject|Read|Reconcile|Report|Register|Pass|Provide|Supply|Use|Hash|Generate|Build|Create|Configure|Set|Set up|Export|Obtain|Wait|Check|Stop|Reduce|Implement|Fix|Inspect|Sign|Call|Send|Make|Rerun|Run|Stage|Restart|Raise|Map|Publish|Start|Give|Only|Claim|Dispatch|Record|Observe|Verify|Retry|Return|Trust|Remove|Lower|Keep|Choose|Include|Correct|Mark|Mint|Treat|The bytes written|A |An |If )/;
  const vague = Object.values(ERROR_TAXONOMY).filter((entry) => !openers.test(entry.fix)).map((entry) => `${entry.code}: ${entry.fix.slice(0, 60)}`);
  assert.deepEqual(vague, []);
});
