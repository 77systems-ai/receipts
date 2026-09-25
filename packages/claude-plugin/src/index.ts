import { createHash } from 'node:crypto';
import { classify, getReceipt, getDefaultStore, type AuditStore, type OutwardWrite } from '@77systems/receipts-core';

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  session_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}
export interface HookOutput {
  hookSpecificOutput: { hookEventName: 'PostToolUse' | 'PostToolUseFailure'; additionalContext: string };
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function message(event: HookOutput['hookSpecificOutput']['hookEventName'], text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** Feedback only. Only a prior audited binding can justify completion here. */
export function evaluateHook(input: HookInput, tools: Record<string, string> = {}, store?: AuditStore): HookOutput | undefined {
  const name = input.tool_name ?? '';
  if (!tools[name] && /(?:^|__)receipts[._](?:classify|record|bind|verify|observe|recheck)$/.test(name)) return undefined;
  const event = input.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse';
  const response = object(input.tool_response);
  const structured = object(response?.structuredContent);
  const envelope = object(response?.receipts) ?? object(structured?.receipts);
  const surface = tools[name] ?? (name === 'Write' || name === 'Edit' || name === 'NotebookEdit' ? 'file-write' : undefined);
  if (!surface) {
    if (envelope || /(?:send|publish|post|create|write|update|delete|Bash|PowerShell)/i.test(name)) {
      return message(event, 'Receipts: adapter_required. This tool has no registered hook mapping. Its result is not verified completion. Configure RECEIPTS_HOOK_TOOLS and a destination observer; never retry an uncertain write or invent an ID.');
    }
    return undefined;
  }
  // Raw tool input is hashed in memory as a fallback tracking digest, never persisted.
  const digest = typeof envelope?.packageDigest === 'string' ? envelope.packageDigest
    : `sha256:${createHash('sha256').update(JSON.stringify(input.tool_input ?? null)).digest('hex')}`;
  const attemptId = input.tool_use_id ?? `hook-${createHash('sha256').update(`${input.session_id ?? ''}:${name}:${digest}`).digest('hex')}`;
  const destinationId = event === 'PostToolUse' && typeof envelope?.destinationId === 'string' ? envelope.destinationId : undefined;
  const destinationAccount = typeof envelope?.destinationAccount === 'string' ? envelope.destinationAccount : undefined;
  const actionId = typeof envelope?.actionId === 'string' ? envelope.actionId : undefined;
  const approvalId = typeof envelope?.approvalId === 'string' ? envelope.approvalId : undefined;
  try {
    const auditStore = store ?? getDefaultStore();
    const receipt = destinationId && input.tool_use_id && destinationAccount && actionId && approvalId
      ? getReceipt(destinationId, digest, auditStore, { surface, attemptId: input.tool_use_id, destinationAccount, actionId })
      : undefined;
    const audited = receipt?.approvalId === approvalId && receipt?.verdict === 'complete' ? receipt : undefined;
    const write: OutwardWrite = {
      surface, attemptId, packageDigest: digest, destinationAccount, actionId, approvalId, destinationId,
      boundPackageDigest: audited ? digest : undefined,
      publicObjectExists: Boolean(destinationId), writeMayHaveHappened: !destinationId,
    };
    const result = {
      ...classify(write), surface, attemptId, destinationAccount: destinationAccount ?? null,
      actionId: actionId ?? null, approvalId: approvalId ?? null, packageDigest: digest,
      evidenceSource: audited?.evidenceSource ?? 'host-supplied',
      independentlyVerified: audited?.independentlyVerified === true,
      observedAt: audited?.observedAt ?? null,
      ...(audited ? { auditEntryId: audited.auditEntryId } : {}),
    };
    const guidance = audited
      ? audited.independentlyVerified
        ? 'The local audit contains an independent destination read. Report its object ID and original observation time; this is historical verification, not a fresh check.'
        : 'The local audit contains a cooperative, host-supplied binding. Report its object ID, original observation time, and host-supplied source; do not claim independent verification.'
      : 'No audited package binding proves this outcome. Do not claim completion. Observe and record the exact destination before binding; do not issue another write.';
    return message(event, `Receipts: ${JSON.stringify(result)}. ${guidance}`);
  } catch {
    return message(event, 'Receipts: verification refused (invalid or unavailable audited evidence). Do not claim completion or retry this write until the evidence can be checked.');
  }
}
