#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { doctor, renderDoctor } from './doctor.js';
import { buildBugReport } from './bug-report.js';

const HELP = `Receipts support CLI
Usage:
  receipts doctor [--json]
      Check Node, real MCP startup, the full tool list, and credential presence.
      Human-readable by default; --json prints { ok, version, checks: [{ name, ok, detail }] }.
  receipts bug-report [--json | --url | --open] [--audit-path FILE] [--tail N] [--no-doctor]
      Assemble a redacted support bundle as a prefilled GitHub issue. Prints the Markdown body;
      --url prints only the prefilled link, --open also opens it in a browser, --json prints the bundle.
      Nothing is submitted. The bundle records configuration presence only, never values, payloads,
      identifiers, digests, or file paths.
`;

function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replaceAll('&', '^&')]]
    : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => { process.stderr.write('Could not launch a browser. Open the link printed by `receipts bug-report --url`.\n'); });
  child.unref();
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') { process.stdout.write(HELP); return command ? 0 : 1; }
  const flags = new Set(rest.filter(arg => arg.startsWith('--') && !['--audit-path', '--tail'].includes(arg)));
  const option = (name: string): string | undefined => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  if (command === 'doctor') {
    for (const flag of flags) if (flag !== '--json') { process.stderr.write(`Unknown option ${flag}.\n${HELP}`); return 1; }
    const report = await doctor();
    process.stdout.write(flags.has('--json') ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report));
    return report.ok ? 0 : 1;
  }
  if (command === 'bug-report') {
    for (const flag of flags) if (!['--json', '--url', '--open', '--no-doctor'].includes(flag)) { process.stderr.write(`Unknown option ${flag}.\n${HELP}`); return 1; }
    const tailValue = option('--tail');
    if (tailValue !== undefined && !/^\d{1,4}$/.test(tailValue)) { process.stderr.write('--tail needs a nonnegative integer.\n'); return 1; }
    const auditPath = option('--audit-path');
    if (rest.includes('--audit-path') && (!auditPath || auditPath.startsWith('--'))) { process.stderr.write('--audit-path needs a file.\n'); return 1; }
    const report = await buildBugReport({ ...(auditPath ? { auditPath } : {}), ...(tailValue !== undefined ? { tail: Number(tailValue) } : {}), includeDoctor: !flags.has('--no-doctor') });
    if (flags.has('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (flags.has('--url')) process.stdout.write(`${report.url}\n`);
    else {
      process.stdout.write(report.body);
      if (flags.has('--open')) { openInBrowser(report.url); process.stderr.write(`Opening a prefilled issue form${report.truncated ? ' (body truncated for the link; paste the report above)' : ''}. Review it before submitting; nothing has been sent.\n`); }
      else process.stderr.write('Review the report above, then open a prefilled issue with `receipts bug-report --open` or print the link with `--url`. Nothing has been sent.\n');
    }
    return 0;
  }
  process.stderr.write(`Unknown command ${command}.\n${HELP}`);
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    // Never print arbitrary exception content: it could carry paths or provider text.
    process.stderr.write('receipts: the command failed before producing a report.\n');
    process.exitCode = 1;
  });
}
