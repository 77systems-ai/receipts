import { createHash } from 'node:crypto';
import { classify, verify, getDefaultStore, type AuditStore, type OutwardWrite } from '@77systems/receipts-core';

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
  if (!tools[name] && /(?:^|__)receipts[._](?:classify|record|bind|verify)$/.test(name)) return undefined;
  const event = input.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse';
  const response = object(input.tool_response);
  const structured = object(response?.structuredContent);
  const envelope = object(response?.receipts) ?? object(structured?.receipts);
  const surface = tools[name] ?? (name === 'Write' || name === 'Edit' || name === 'NotebookEdit' ? 'file-write' : undefined);
  if (!surface) {
    if (envelope || /(?:send|publish|post|create|write|update|delete|Bash|PowerShell)/i.test(name)) {
      return message(event, 'Receipts: adapter_required. This tool has no registered hook mapping. Its result is not verified completion. Configure RECEIPTS_HOOK_TOOLS and a trusted observation adapter; never retry an uncertain write or invent an ID.');
    }
    return undefined;
  }
  // A digest of raw tool input is only a fallback tracking digest; it is never a binding.
  const digest = typeof envelope?.packageDigest === 'string' ? envelope.packageDigest
    : `sha256:${createHash('sha256').update(JSON.stringify(input.tool_input ?? null)).digest('hex')}`;
  const attemptId = input.tool_use_id ?? `hook-${createHash('sha256').update(`${input.session_id ?? ''}:${name}:${digest}`).digest('hex')}`;
  const destinationId = event === 'PostToolUse' && typeof envelope?.destinationId === 'string' ? envelope.destinationId : undefined;
  try {
    const auditStore = store ?? getDefaultStore();
    const sameActionBinding = destinationId && input.tool_use_id && auditStore.read().some(entry =>
      entry.event === 'binding' && entry.surface === surface && entry.attemptId === input.tool_use_id &&
      entry.destinationId === destinationId && entry.packageDigest === digest);
    const audited = Boolean(sameActionBinding && verify(destinationId!, digest, auditStore) === 'complete');
    const write: OutwardWrite = {
      surface, attemptId, packageDigest: digest,
      destinationId,
      boundPackageDigest: audited ? digest : undefined,
      publicObjectExists: Boolean(destinationId),
      writeMayHaveHappened: !destinationId,
    };
    const result = classify(write);
    return message(event, `Receipts: ${JSON.stringify(result)}. ${audited ? 'A matching binding exists in the local audit. Report its object ID; evidence authenticity depends on the configured adapter.' : 'No audited package binding proves this outcome. Do not claim completion. Observe and record the exact destination before binding; do not issue another write.'}`);
  } catch (error) {
    return message(event, `Receipts: verification refused (${error instanceof Error ? error.message : 'invalid evidence'}). Do not claim completion or retry this write until the evidence can be checked.`);
  }
}
