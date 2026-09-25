import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { JsonlAuditStore, ReceiptsError } from '@77systems/receipts-core';
import '@77systems/receipts-github'; // Registers the GitHub surface so audits containing it validate.
import { doctor, PACKAGE_VERSION, type DoctorReport } from './doctor.js';

export const ISSUES_URL = 'https://github.com/77systems-ai/receipts/issues/new';
/** Environment variables Receipts reads. The bundle records presence only, never a value. */
export const CONFIGURATION_KEYS = [
  'RECEIPTS_AUDIT_PATH', 'RECEIPTS_GITHUB_REPO', 'GITHUB_TOKEN', 'GH_TOKEN',
  'RECEIPTS_POLICY_PATH', 'RECEIPTS_CLAIM_TTL_MS', 'RECEIPTS_SIGNING_KEY_PATH', 'RECEIPTS_HOOK_TOOLS',
] as const;
/** GitHub's new-issue form accepts roughly 8 KiB of URL; longer bodies are pasted from the terminal instead. */
const MAX_URL_LENGTH = 8000;

export interface AuditTailEntry {
  sequence: number; timestamp: string; event: string; verdict: string; surface: string;
  admission: string | null; evidenceSource: string;
}
export interface AuditHealth {
  location: 'flag' | 'environment' | 'default';
  exists: boolean;
  entries: number | null;
  headCheckpoint: boolean;
  /** valid, or the ReceiptsError code that validation produced. */
  chain: string;
  tail: AuditTailEntry[];
}
export interface BugReportBundle {
  generatedAt: string;
  environment: { node: string; platform: string; release: string; arch: string };
  packages: Record<string, string>;
  configuration: Record<(typeof CONFIGURATION_KEYS)[number], 'present' | 'absent'>;
  doctor: DoctorReport | null;
  audit: AuditHealth;
}
export interface BugReport {
  title: string;
  /** Markdown issue body. Contains no payloads, credentials, identifiers, digests, or file paths. */
  body: string;
  /** Prefilled GitHub new-issue link. Opening it never submits anything. */
  url: string;
  truncated: boolean;
  bundle: BugReportBundle;
}
export interface BugReportOptions {
  auditPath?: string;
  /** Number of most recent audit entries to summarize by shape. 0 disables the table. */
  tail?: number;
  includeDoctor?: boolean;
  env?: NodeJS.ProcessEnv;
}

function packageVersions(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const own = require('../package.json') as { name: string; version: string; dependencies?: Record<string, string> };
  const versions: Record<string, string> = { [own.name]: own.version };
  for (const [name, declared] of Object.entries(own.dependencies ?? {})) {
    let installed: string | undefined;
    try { installed = (require(`${name}/package.json`) as { version: string }).version; } catch { /* Not every package exports package.json. */ }
    versions[name] = installed && installed !== declared ? `${installed} (declared ${declared})` : declared;
  }
  return versions;
}

/** Only shape fields leave the audit: no identifiers, accounts, digests, evidence, or lease metadata. */
function auditHealth(options: BugReportOptions, env: NodeJS.ProcessEnv): AuditHealth {
  const location: AuditHealth['location'] = options.auditPath ? 'flag' : env.RECEIPTS_AUDIT_PATH ? 'environment' : 'default';
  const path = resolve(options.auditPath ?? env.RECEIPTS_AUDIT_PATH ?? '.receipts/audit.jsonl');
  const health: AuditHealth = { location, exists: existsSync(path), entries: null, headCheckpoint: existsSync(`${path}.head`), chain: 'unread', tail: [] };
  if (!health.exists) { health.chain = health.headCheckpoint ? 'audit_corrupt' : 'absent'; return health; }
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    health.entries = lines.length;
    const tail = Math.max(0, options.tail ?? 20);
    // slice(-0) would return every line; zero means no table at all.
    for (const line of tail === 0 ? [] : lines.slice(-tail)) {
      let envelope: { sequence?: unknown; entry?: Record<string, unknown> & { admission?: { verdict?: unknown } } };
      try { envelope = JSON.parse(line); } catch { health.tail.push({ sequence: -1, timestamp: '', event: 'unparseable', verdict: '', surface: '', admission: null, evidenceSource: '' }); continue; }
      const entry = envelope.entry ?? {};
      health.tail.push({
        sequence: typeof envelope.sequence === 'number' ? envelope.sequence : -1,
        timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
        event: typeof entry.event === 'string' ? entry.event : '',
        verdict: typeof entry.verdict === 'string' ? entry.verdict : '',
        surface: typeof entry.surface === 'string' ? entry.surface : '',
        admission: typeof entry.admission?.verdict === 'string' ? entry.admission.verdict : null,
        evidenceSource: typeof entry.evidenceSource === 'string' ? entry.evidenceSource : 'host-supplied',
      });
    }
  } catch { health.chain = 'unreadable'; return health; }
  try { new JsonlAuditStore(path).read(); health.chain = 'valid'; }
  catch (error) { health.chain = error instanceof ReceiptsError ? error.code : 'unreadable'; }
  return health;
}

function table(rows: readonly (readonly string[])[], header: readonly string[]): string {
  const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [`| ${header.map(cell).join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

/**
 * Defense in depth: even though nothing above prints configured values, any configured value that
 * somehow appears in the body is replaced. Values shorter than four characters are too ambiguous to match.
 */
function redact(body: string, env: NodeJS.ProcessEnv): string {
  let result = body;
  for (const key of CONFIGURATION_KEYS) {
    const value = env[key]?.trim();
    if (value && value.length >= 4) result = result.split(value).join('[redacted]');
  }
  return result;
}

export function renderBugReport(bundle: BugReportBundle): { title: string; body: string } {
  const title = `Bug report: @77systems/receipts-mcp ${PACKAGE_VERSION} (${bundle.environment.platform}/${bundle.environment.arch}, node ${bundle.environment.node})`;
  const sections = [
    '## Summary', '', '<!-- What did you expect, and what happened instead? Do not paste payloads, tokens, audit files, or identifiers. -->', '',
    '## Steps to reproduce', '', '1. ', '',
    '## Environment', '', table([['node', bundle.environment.node], ['platform', `${bundle.environment.platform} ${bundle.environment.release}`], ['arch', bundle.environment.arch]], ['Field', 'Value']), '',
    '## Packages', '', table(Object.entries(bundle.packages), ['Package', 'Version']), '',
    '## Configuration', '', 'Presence only. Values are never collected.', '', table(Object.entries(bundle.configuration), ['Variable', 'State']), '',
    '## Doctor', '',
    bundle.doctor ? table(bundle.doctor.checks.map(check => [check.name, check.ok ? 'ok' : 'FAIL', check.detail]), ['Check', 'Result', 'Detail']) : 'Skipped (`--no-doctor`).', '',
    '## Audit health', '',
    `- location: ${bundle.audit.location} (path not included)`,
    `- exists: ${bundle.audit.exists ? 'yes' : 'no'}; entries: ${bundle.audit.entries ?? 'unknown'}; head checkpoint: ${bundle.audit.headCheckpoint ? 'present' : 'absent'}; chain: ${bundle.audit.chain}`,
    '',
  ];
  if (bundle.audit.tail.length) {
    sections.push(`Last ${bundle.audit.tail.length} entries by shape. Identifiers, accounts, digests, evidence, and lease metadata are omitted.`, '',
      table(bundle.audit.tail.map(entry => [String(entry.sequence), entry.timestamp, entry.event, entry.verdict, entry.admission ?? '', entry.evidenceSource, entry.surface]),
        ['#', 'Timestamp', 'Event', 'Verdict', 'Admission', 'Source', 'Surface']), '');
  }
  sections.push(`_Generated at ${bundle.generatedAt} by \`receipts bug-report\`. Review before submitting; the bundle contains no payloads, secrets, identifiers, or file paths._`);
  return { title, body: `${sections.join('\n')}\n` };
}

export function issueUrl(title: string, body: string): { url: string; truncated: boolean } {
  const base = `${ISSUES_URL}?title=${encodeURIComponent(title)}&body=`;
  const full = `${base}${encodeURIComponent(body)}`;
  if (full.length <= MAX_URL_LENGTH) return { url: full, truncated: false };
  const note = '\n\n_Truncated for the link. Paste the full report printed by `receipts bug-report`._\n';
  let cut = body.length;
  while (cut > 0 && `${base}${encodeURIComponent(body.slice(0, cut) + note)}`.length > MAX_URL_LENGTH) cut = Math.floor(cut * 0.9);
  return { url: `${base}${encodeURIComponent(body.slice(0, cut) + note)}`, truncated: true };
}

/** Assemble the support bundle. Nothing is submitted, uploaded, or written. */
export async function buildBugReport(options: BugReportOptions = {}): Promise<BugReport> {
  const env = options.env ?? process.env;
  const bundle: BugReportBundle = {
    generatedAt: new Date().toISOString(),
    environment: { node: process.versions.node, platform: platform(), release: release(), arch: arch() },
    packages: packageVersions(),
    configuration: Object.fromEntries(CONFIGURATION_KEYS.map(key => [key, env[key]?.trim() ? 'present' : 'absent'])) as BugReportBundle['configuration'],
    doctor: options.includeDoctor === false ? null : await doctor(),
    audit: auditHealth(options, env),
  };
  const rendered = renderBugReport(bundle);
  const body = redact(rendered.body, env);
  const { url, truncated } = issueUrl(rendered.title, body);
  return { title: rendered.title, body, url, truncated, bundle };
}
