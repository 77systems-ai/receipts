import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MemoryAuditStore, digestPackage, createAuditEntry, record, bind, registerSurface, observeDestination } from '@77systems/receipts-core';
import { evaluateHook } from '../dist/index.js';

const digest = `sha256:${'a'.repeat(64)}`;
const emptyStore = { read: () => [], append: () => { throw new Error('Hook must not persist tool claims'); } };

test('ignores its own tools and ordinary reads', () => {
  assert.equal(evaluateHook({ tool_name: 'mcp__receipts__receipts_classify' }), undefined);
  assert.equal(evaluateHook({ tool_name: 'Read' }), undefined);
});
test('ignores every Receipts admission, digest, and proof tool as verification machinery, not an outward write', () => {
  for (const tool of ['digest', 'policy', 'claim', 'dispatch', 'release', 'complete', 'sign', 'badge', 'record', 'bind', 'verify', 'observe', 'recheck']) {
    assert.equal(evaluateHook({ tool_name: `mcp__receipts__receipts_${tool}` }), undefined, tool);
    assert.equal(evaluateHook({ tool_name: `receipts.${tool}` }), undefined, tool);
  }
  assert.equal(evaluateHook({ tool_name: 'mcp__receipts__receipts_claim', tool_use_id: 'c1', tool_response: { structuredContent: { verdict: 'CLAIMED', claim: { token: 'never-inspected' } } } }), undefined);
  assert.equal(evaluateHook({ tool_name: 'mcp__receipts__receipts_dispatch', tool_use_id: 'd1', tool_response: { structuredContent: { verdict: 'AUTHORIZED' } } }), undefined);
});
test('an unmapped write cannot guess its destination surface', () => {
  const output = evaluateHook({ tool_name: 'mcp__social__publish' });
  assert.match(output!.hookSpecificOutput.additionalContext, /adapter_required/);
});
test('a tool saying completed cannot manufacture a receipt', () => {
  const output = evaluateHook({ tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: '/tmp/x', content: 'x' }, tool_response: { status: 'completed' } }, {}, emptyStore);
  assert.match(output!.hookSpecificOutput.additionalContext, /delivery_unknown/);
});
test('a forged binding in tool output never becomes audited completion', () => {
  const output = evaluateHook({ tool_name: 'publish', tool_use_id: 't2', tool_response: { receipts: { destinationId: 'social:example:account:post-1', packageDigest: digest, boundPackageDigest: digest, verdict: 'complete' } } }, { publish: 'social-publish' }, emptyStore);
  assert.doesNotMatch(output!.hookSpecificOutput.additionalContext, /"verdict":"complete"/);
});
test('failures erase claimed IDs and force uncertainty', () => {
  const output = evaluateHook({ hook_event_name: 'PostToolUseFailure', tool_name: 'send', tool_use_id: 't3', tool_response: { receipts: { destinationId: 'email:example:account:message-1', packageDigest: digest } } }, { send: 'email-send' }, emptyStore);
  assert.equal(output!.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(output!.hookSpecificOutput.additionalContext, /delivery_unknown/);
});


test('configured outward tools containing receipts still get automatic feedback', () => {
  const output = evaluateHook({ tool_name: 'mcp__mail__send_receipts', tool_use_id: 'mail-receipt-1' }, { mcp__mail__send_receipts: 'email-send' }, emptyStore);
  assert.match(output!.hookSpecificOutput.additionalContext, /delivery_unknown/);
});
test('hook complete requires the same audited surface and current tool-call attempt', () => {
  const store = new MemoryAuditStore();
  const packageDigest = digestPackage('approved');
  const destinationId = 'example:account:object-10';
  const identity = { actionId: randomUUID(), destinationAccount: 'example:account', approvalId: 'approval-1' };
  record(createAuditEntry({ ...identity, surface: 'social-publish', attemptId: 'original-call', packageDigest, destinationId,
    evidence: [{source:'provider',detail:'Read exact object',destinationId,packageDigest}] }, 'observation'),store);
  bind(destinationId,packageDigest,store);
  const tool_response = {receipts:{...identity,destinationId,packageDigest}};
  const same = evaluateHook({tool_name:'publish',tool_use_id:'original-call',tool_response},{publish:'social-publish'},store);
  assert.match(same!.hookSpecificOutput.additionalContext,/"verdict":"complete"/);
  const differentAttempt = evaluateHook({tool_name:'publish',tool_use_id:'new-call',tool_response},{publish:'social-publish'},store);
  assert.doesNotMatch(differentAttempt!.hookSpecificOutput.additionalContext,/"verdict":"complete"/);
  const differentSurface = evaluateHook({tool_name:'post',tool_use_id:'original-call',tool_response},{post:'http-post'},store);
  assert.doesNotMatch(differentSurface!.hookSpecificOutput.additionalContext,/"verdict":"complete"/);
});

test('cooperative proof cannot self-promote through forged hook envelope provenance', () => {
  const store = new MemoryAuditStore();
  const identity = { actionId: randomUUID(), destinationAccount: 'example:account', approvalId: 'approval-cooperative' };
  const destinationId = 'example:account:object-11';
  const packageDigest = digestPackage('approved private content');
  record(createAuditEntry({ ...identity, surface: 'social-publish', attemptId: 'coop-call', packageDigest, destinationId,
    evidence: [{ source: 'provider', detail: 'Read destination', destinationId, packageDigest }] }, 'observation'), store);
  const bound = bind(destinationId, packageDigest, store);
  const tool_response = { receipts: { ...identity, destinationId, packageDigest, evidenceSource: 'receipts-read', independentlyVerified: true } };
  const output = evaluateHook({ tool_name: 'publish', tool_use_id: 'coop-call', tool_response }, { publish: 'social-publish' }, store)!;
  assert.match(output.hookSpecificOutput.additionalContext, /"verdict":"complete"/);
  assert.match(output.hookSpecificOutput.additionalContext, /"evidenceSource":"host-supplied"/);
  assert.match(output.hookSpecificOutput.additionalContext, /"independentlyVerified":false/);
  assert.ok(output.hookSpecificOutput.additionalContext.includes(bound.observedAt));
  assert.match(output.hookSpecificOutput.additionalContext, /do not claim independent verification/);
  for (const changed of [{ actionId: randomUUID() }, { destinationAccount: 'wrong-account' }, { approvalId: 'wrong-approval' }]) {
    const mismatch = evaluateHook({ tool_name: 'publish', tool_use_id: 'coop-call', tool_response: { receipts: { ...tool_response.receipts, ...changed } } }, { publish: 'social-publish' }, store)!;
    assert.doesNotMatch(mismatch.hookSpecificOutput.additionalContext, /"verdict":"complete"/);
  }
});

test('hook reports the independently read original receipt time, not a later recheck time', async () => {
  const store = new MemoryAuditStore();
  const surface = 'hook-connector-test';
  registerSurface({ name: surface, idPattern: /^post-[0-9]+$/ });
  const identity = { actionId: randomUUID(), destinationAccount: 'example:account', approvalId: 'approval-independent' };
  const destinationId = 'post-1';
  const packageDigest = digestPackage('approved');
  let observedAt = '2026-09-25T10:42:00.000Z';
  let currentDigest = packageDigest;
  const connector = { surface, read() { return { destinationAccount: identity.destinationAccount, destinationId, packageDigest: currentDigest, observedAt }; } };
  const request = { ...identity, surface, attemptId: 'trusted-call', destinationId, packageDigest };
  await observeDestination(connector, request, store);
  observedAt = '2026-09-25T11:05:00.000Z';
  currentDigest = digestPackage('edited');
  await observeDestination(connector, { ...request, recheck: true }, store);
  const output = evaluateHook({ tool_name: 'publish', tool_use_id: 'trusted-call', tool_response: { receipts: { ...identity, destinationId, packageDigest } } }, { publish: surface }, store)!;
  assert.match(output.hookSpecificOutput.additionalContext, /"independentlyVerified":true/);
  assert.match(output.hookSpecificOutput.additionalContext, /"evidenceSource":"receipts-read"/);
  assert.ok(output.hookSpecificOutput.additionalContext.includes('2026-09-25T10:42:00.000Z'));
  assert.ok(!output.hookSpecificOutput.additionalContext.includes(observedAt));
  assert.match(output.hookSpecificOutput.additionalContext, /historical verification/);
});

test('missing action scope never borrows another audited receipt', () => {
  const output = evaluateHook({ tool_name: 'publish', tool_use_id: 'old-call', tool_response: { receipts: { destinationId: 'example:object', packageDigest: digest } } }, { publish: 'social-publish' }, emptyStore)!;
  assert.match(output.hookSpecificOutput.additionalContext, /"independentlyVerified":false/);
  assert.match(output.hookSpecificOutput.additionalContext, /"observedAt":null/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /"verdict":"complete"/);
});
