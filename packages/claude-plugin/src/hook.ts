#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluateHook, type HookInput } from './index.js';
try {
  const raw = readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Hook input exceeds 1 MiB');
  const input = JSON.parse(raw) as HookInput;
  const mappings: unknown = JSON.parse(process.env.RECEIPTS_HOOK_TOOLS ?? '{}');
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings) || Object.values(mappings).some(value => typeof value !== 'string')) {
    throw new Error('RECEIPTS_HOOK_TOOLS must map exact tool names to surface names');
  }
  const output = evaluateHook(input, mappings as Record<string, string>);
  if (output) process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stderr.write(`Receipts hook failed closed: ${error instanceof Error ? error.message : 'invalid input'}. Completion is unverified.\n`);
  process.exitCode = 2;
}
