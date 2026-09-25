import assert from "node:assert/strict";

import { after, describe, it, type TestContext } from "node:test";
import {
  MemoryAuditStore,
  bind,
  createAuditEntry,
  getReceipt,
  record,
  type AuditEntry,
  type DestinationConnector,
} from "@77systems/receipts-core";
import { createReceipts, digestPayload, DuplicateWriteError, VerificationPendingError } from "@77systems/receipts-sdk";
import { buildEvaluationReceipt, emitEvaluation, initialCaseResults, seededIdentity, type CaseResult, type ConformanceOptions } from "./evaluation.js";
export { CONFORMANCE_BENCHMARK, assessCertification, evaluationDigest, seededIdentity } from "./evaluation.js";
export type { CaseResult, CalibrationRate, ConformanceOptions, DecisionResult, EvaluationReceipt, EvaluationPublication } from "./evaluation.js";

/**
 * A deterministic destination controlled by your connector's test transport.
 * Use the real connector implementation with a mocked provider API. These
 * controls must change the provider response, not rewrite returned receipts.
 */
export interface ConnectorFixture {
  connector: DestinationConnector;
  payload: unknown;
  destinationAccount: string;
  destinationId: string;
  locator?: Record<string, string | number>;
  write(): void | Promise<void>;
  writes(): number;
  reads(): number;
  changeContent(): void | Promise<void>;
  setWrongAccount(): void | Promise<void>;
  setReadFailure(message: string): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export type ConnectorFixtureFactory = (context: TestContext) => ConnectorFixture | Promise<ConnectorFixture>;

const PRIVATE_MARKER = "conformance-private-content-do-not-store-7f64bfe4";

/**
 * Public connector benchmark v2. Each run emits a local, self-attested evaluation receipt. Registers sequential node:test cases.
 * Passing proves these behaviors under the fixture, not live API delivery.
 */
export function connectorConformance(name: string, factory: ConnectorFixtureFactory, evaluation: ConformanceOptions = {}): void {
  const seed = evaluation.seed ?? "receipts-conformance-v2";
  const caseResults = initialCaseResults(seed);
  const fixtures = new WeakMap<TestContext, ConnectorFixture>();
  let activeCase: CaseResult;
  let identityCounter = 0;
  const nextIdentity = () => seededIdentity(seed, activeCase.name, `identity-${identityCounter++}`);
  const score = (decision: string, accepted: boolean) => {
    const result = activeCase.decisions.find((item) => item.name === decision);
    if (!result) throw new Error("Unknown benchmark decision.");
    result.observed = accepted ? "accept" : "reject";
  };
  const runCase = (caseName: string, description: string, action: (context: TestContext) => Promise<void>) => {
    it(description, async (context) => {
      activeCase = caseResults.find((item) => item.name === caseName)!;
      identityCounter = 0;
      try {
        await action(context);
        activeCase.status = "passed";
      } catch (error) {
        activeCase.status = "failed";
        activeCase.failureCode = error instanceof assert.AssertionError ? "assertion_failed" : "fixture_or_operation_failed";
        // Report only the stable case identifier; arbitrary errors can include payloads or tokens.
        throw new Error(`Conformance case failed: ${caseName}. See its sanitized evaluation receipt.`);
      } finally {
        const fixture = fixtures.get(context);
        if (fixture?.dispose) {
          try { await fixture.dispose(); }
          catch {
            activeCase.status = "failed";
            activeCase.failureCode = "cleanup_failed";
            throw new Error(`Conformance cleanup failed: ${caseName}.`);
          }
        }
      }
    });
  };
  describe(`${name}: Receipts connector conformance`, { concurrency: false }, () => {
    after(async () => { await emitEvaluation(buildEvaluationReceipt(name, evaluation, caseResults), evaluation); });
    async function setup(context: TestContext) {
      const fixture = await factory(context);
      fixtures.set(context, fixture);
      const store = new MemoryAuditStore();
      const client = createReceipts({ store, connector: fixture.connector });
      const actionId = nextIdentity();
      const options = {
        surface: fixture.connector.surface, attemptId: `conformance-${nextIdentity()}`, actionId,
        destinationAccount: fixture.destinationAccount, approvalId: `approval-${nextIdentity()}`, payload: fixture.payload,
        async execute() { await fixture.write(); throw new Error(PRIVATE_MARKER); },
      };
      const readOptions = { surface: options.surface, attemptId: options.attemptId, payload: fixture.payload,
        destinationId: fixture.destinationId, ...(fixture.locator ? { locator: fixture.locator } : {}) };
      return { fixture, store, client, options, readOptions };
    }

    runCase("lost-response", "survives a lost response, blocks the duplicate, and independently reads the existing object", async (context) => {
      const { fixture, store, client, options, readOptions } = await setup(context);
      const pending = await client.execute(options);
      score("uncertain-completion", pending.classification.verdict === "complete");
      assert.equal(pending.classification.verdict, "delivery_unknown");
      assert.equal(pending.classification.mayAutoRetry, false);
      assert.equal(pending.classification.maySecondWrite, false);
      assert.throws(() => client.claimComplete(pending), VerificationPendingError);
      assert.equal(fixture.writes(), 1);
      assert.equal(fixture.reads(), 0);
      let duplicateError: unknown;
      try { await client.execute({ ...options, attemptId: `retry-${nextIdentity()}` }); } catch (error) { duplicateError = error; }
      score(activeCase.name === "timeout" ? "timeout-duplicate-dispatch" : "duplicate-dispatch", fixture.writes() > 1);
      assert.ok(duplicateError instanceof DuplicateWriteError);
      assert.equal(fixture.writes(), 1);
      let receipt;
      try { receipt = await client.reconcile(readOptions); }
      catch (error) { score("recovered-completion", false); throw error; }
      score("recovered-completion", receipt.classification.verdict === "complete" && receipt.independentlyVerified);
      assert.equal(fixture.reads(), 1, "Receipts must execute the connector read itself");
      assert.equal(receipt.classification.verdict, "complete");
      assert.equal(receipt.evidenceSource, "receipts-read");
      assert.equal(receipt.independentlyVerified, true);
      assert.equal(receipt.destinationAccount, options.destinationAccount);
      assert.equal(receipt.actionId, options.actionId);
      assert.equal(receipt.approvalId, options.approvalId);
      assert.equal(receipt.packageDigest, digestPayload(fixture.payload));
      assert.equal(receipt.destinationId, fixture.destinationId);
      assert.ok(receipt.observedAt && Number.isFinite(Date.parse(receipt.observedAt)));
      assert.equal(client.claimComplete(receipt, { requireIndependent: true }), fixture.destinationId);
      assert.doesNotMatch(JSON.stringify(store.read()), new RegExp(PRIVATE_MARKER));
      assert.equal(fixture.writes(), 1);
    });

    runCase("wrong-account", "rejects a read from the wrong destination account", async (context) => {
      const { fixture, store, client, options, readOptions } = await setup(context);
      await client.execute(options);
      await fixture.setWrongAccount();
      const result = await client.reconcile(readOptions);
      score("wrong-account-completion", result.classification.verdict === "complete");
      assert.notEqual(result.classification.verdict, "complete");
      assert.equal(result.independentlyVerified, false);
      assert.throws(() => client.claimComplete(result), VerificationPendingError);
      assert.ok(!store.read().some((entry) => entry.event === "binding"));
      assert.equal(fixture.writes(), 1);
    });

    runCase("changed-content", "preserves placement but refuses binding when the destination content changed", async (context) => {
      const { fixture, store, client, options, readOptions } = await setup(context);
      await client.execute(options);
      await fixture.changeContent();
      const result = await client.reconcile(readOptions);
      score("edited-completion", result.classification.verdict === "complete");
      assert.equal(result.classification.verdict, "package_unverified");
      assert.equal(result.destinationId, fixture.destinationId);
      assert.equal(result.independentlyVerified, true, "An independent read can discover a mismatch without proving completion");
      assert.notEqual(result.observedPackageDigest, result.packageDigest);
      assert.throws(() => client.claimComplete(result), VerificationPendingError);
      assert.ok(!store.read().some((entry) => entry.event === "binding"));
      assert.equal(fixture.writes(), 1);
    });

    runCase("timeout", "keeps connector timeouts uncertain and excludes provider errors from the audit", async (context) => {
      const { fixture, store, client, options, readOptions } = await setup(context);
      await client.execute(options);
      await fixture.setReadFailure(PRIVATE_MARKER);
      const result = await client.reconcile(readOptions);
      score("timeout-completion", result.classification.verdict === "complete");
      assert.equal(result.classification.verdict, "delivery_unknown");
      assert.equal(result.independentlyVerified, false);
      assert.equal(result.classification.mayAutoRetry, false);
      assert.equal(result.classification.maySecondWrite, false);
      let duplicateError: unknown;
      try { await client.execute({ ...options, attemptId: `retry-${nextIdentity()}` }); } catch (error) { duplicateError = error; }
      score(activeCase.name === "timeout" ? "timeout-duplicate-dispatch" : "duplicate-dispatch", fixture.writes() > 1);
      assert.ok(duplicateError instanceof DuplicateWriteError);
      assert.doesNotMatch(JSON.stringify(store.read()), new RegExp(PRIVATE_MARKER));
      assert.equal(fixture.writes(), 1);
    });

    runCase("forged-evidence", "cannot promote forged provider evidence to independent proof", async (context) => {
      const { fixture, store, options } = await setup(context);
      const packageDigest = digestPayload(fixture.payload);
      const observation = createAuditEntry({ surface: options.surface, attemptId: options.attemptId,
        actionId: options.actionId, destinationAccount: options.destinationAccount, approvalId: options.approvalId,
        packageDigest, destinationId: fixture.destinationId,
        evidence: [{ source: "provider", detail: PRIVATE_MARKER, destinationId: fixture.destinationId, packageDigest,
          reference: `https://invalid.example/${PRIVATE_MARKER}` }] }, "observation");
      record({ ...observation, evidenceSource: "receipts-read", independentlyVerified: true } as AuditEntry, store);
      const forged = bind(fixture.destinationId, packageDigest, store);
      score("forged-independent-completion", forged.independentlyVerified);
      assert.equal(forged.evidenceSource, "host-supplied");
      assert.equal(forged.independentlyVerified, false);
      assert.equal(fixture.reads(), 0);
      assert.equal(fixture.writes(), 0);
      assert.doesNotMatch(JSON.stringify(store.read()), new RegExp(PRIVATE_MARKER));
    });

    runCase("reapproved-content", "allows the same content only with a new action and new approval", async (context) => {
      const { fixture, client, options } = await setup(context);
      const first = await client.execute(options);
      let duplicateError: unknown;
      try { await client.execute({ ...options, actionId: nextIdentity(), attemptId: `reuse-approval-${nextIdentity()}` }); } catch (error) { duplicateError = error; }
      score("recycled-approval-dispatch", fixture.writes() > 1);
      assert.ok(duplicateError instanceof DuplicateWriteError);
      let second;
      try { second = await client.execute({ ...options, actionId: nextIdentity(), approvalId: `approval-${nextIdentity()}`, attemptId: `next-${nextIdentity()}` }); }
      catch (error) { score("new-approval-dispatch", false); throw error; }
      score("new-approval-dispatch", fixture.writes() === 2);
      assert.equal(second.packageDigest, first.packageDigest);
      assert.notEqual(second.actionId, first.actionId);
      assert.equal(fixture.writes(), 2);
    });

    runCase("recheck-history", "appends unchanged and edited rechecks without overwriting the original receipt", async (context) => {
      const { fixture, store, client, options, readOptions } = await setup(context);
      await client.execute(options);
      const original = await client.reconcile(readOptions);
      const savedReceipt = structuredClone(original);
      const originalEntries = store.read();
      let same;
      try { same = await client.recheck(readOptions); }
      catch (error) { score("unchanged-recheck-completion", false); throw error; }
      score("unchanged-recheck-completion", same.classification.verdict === "complete");
      assert.equal(same.classification.verdict, "complete");
      assert.notEqual(same.auditEntryId, original.auditEntryId);
      assert.equal(client.claimComplete(same, { requireIndependent: true }), fixture.destinationId);
      await fixture.changeContent();
      const changed = await client.recheck(readOptions);
      score("edited-recheck-completion", changed.classification.verdict === "complete");
      assert.equal(changed.classification.verdict, "package_unverified");
      assert.notEqual(changed.auditEntryId, original.auditEntryId);
      assert.deepEqual(original, savedReceipt);
      assert.deepEqual(store.read().slice(0, originalEntries.length), originalEntries);
      assert.equal(store.read().filter((entry) => entry.event === "recheck").length, 2);
      assert.equal(getReceipt(fixture.destinationId, original.packageDigest, store, {
        destinationAccount: original.destinationAccount, actionId: original.actionId, surface: original.surface,
      })?.observedAt, original.observedAt);
      let historical: string;
      try { historical = client.claimComplete(original, { requireIndependent: true }); }
      catch (error) { score("historical-completion", false); throw error; }
      score("historical-completion", historical === fixture.destinationId);
      assert.equal(historical, fixture.destinationId);
      assert.equal(fixture.reads(), 3);
      assert.equal(fixture.writes(), 1);
    });
  });
}
