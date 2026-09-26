import { getSurface, registerSurface, ReceiptsError, type TrustedConnector, type ConnectorRequest } from '@77systems/receipts-core';
import { digestPayload } from '@77systems/receipts-sdk';
import { createRequire } from 'node:module';

const PACKAGE_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export const GITHUB_ISSUE_SURFACE = 'github-issue';
const slug = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,99})$/;
const objectPattern = /^github:issue:([a-z0-9_.-]+)\/([a-z0-9_.-]+):([1-9]\d*):([1-9]\d*)$/;
try { getSurface(GITHUB_ISSUE_SURFACE); }
catch (error) {
  if (!(error instanceof ReceiptsError) || error.code !== 'not_a_destination_write') throw error;
  registerSurface({ name: GITHUB_ISSUE_SURFACE, idPattern: objectPattern });
}

export interface GitHubIssuePayload { title: string; body: string }
export function githubIssuePayload(title: string, body: string | null): GitHubIssuePayload {
  if (typeof title !== 'string' || (typeof body !== 'string' && body !== null)) throw new ReceiptsError('invalid_issue_payload', 'An issue title and body are required.');
  return { title, body: body ?? '' };
}
export function githubAccount(owner: string, repo: string): string {
  if (!slug.test(owner) || !slug.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    throw new ReceiptsError('invalid_github_repository', 'Use an exact GitHub owner and repository name.');
  }
  return `github:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}
function fail(code: string, message: string): never { throw new ReceiptsError(code, message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_github_response', 'GitHub returned an invalid issue record.');
  return value as Record<string, unknown>;
}

export interface GitHubConnectorOptions {
  owner: string;
  repo: string;
  /** Local token; sent only as authorization to api.github.com. Never audited. */
  token?: string;
  timeoutMs?: number;
}

/** Fixed GitHub origin, read-only, no redirect following and no telemetry. */
export function createGitHubIssuesConnector(options: GitHubConnectorOptions): TrustedConnector {
  const account = githubAccount(options.owner, options.repo);
  const owner = options.owner.toLowerCase();
  const repo = options.repo.toLowerCase();
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('invalid_timeout', 'Read timeout must be between 1 and 60000 milliseconds.');
  const token = options.token ?? (process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim());
  return Object.freeze({
    surface: GITHUB_ISSUE_SURFACE,
    async read(request: ConnectorRequest) {
      if (request.destinationAccount !== account) fail('account_mismatch', 'The requested destination account does not match this connector.');
      let number = request.locator?.issueNumber;
      let expectedImmutableId: string | undefined;
      if (request.destinationId) {
        const parsed = objectPattern.exec(request.destinationId);
        if (!parsed || parsed[1] !== owner || parsed[2] !== repo) fail('object_mismatch', 'The destination object is outside this GitHub repository.');
        if (number !== undefined && String(number) !== parsed[3]) fail('object_mismatch', 'The issue locator and destination object disagree.');
        number = parsed[3];
        expectedImmutableId = parsed[4];
      }
      if (typeof number !== 'number' && typeof number !== 'string') fail('invalid_locator', 'Provide locator.issueNumber or a previously observed GitHub issue ID.');
      if (!/^[1-9]\d*$/.test(String(number)) || !Number.isSafeInteger(Number(number))) fail('invalid_locator', 'The issue number must be a positive integer.');
      if (!token || !token.trim()) fail('missing_github_token', 'Set GITHUB_TOKEN or GH_TOKEN locally.');
      const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'user-agent': `receipts/${PACKAGE_VERSION}` },
        });
      } catch { return fail('github_read_failed', 'GitHub could not be read. The outcome remains unverified.'); }
      if (response.status !== 200) fail('github_read_failed', `GitHub read returned HTTP ${response.status}. No receipt was issued.`);
      let data: Record<string, unknown>;
      try { data = object(await response.json()); }
      catch { return fail('invalid_github_response', 'GitHub returned an invalid issue record.'); }
      if (data.pull_request !== undefined) fail('not_a_github_issue', 'Pull requests are outside the GitHub issues connector.');
      if (!Number.isSafeInteger(data.id) || Number(data.id) < 1 || data.number !== Number(number) ||
          typeof data.repository_url !== 'string' || data.repository_url.toLowerCase() !== `https://api.github.com/repos/${owner}/${repo}` ||
          typeof data.url !== 'string' || data.url.toLowerCase() !== url || typeof data.title !== 'string' || (typeof data.body !== 'string' && data.body !== null)) {
        fail('object_mismatch', 'The observed issue does not match the exact requested repository and object.');
      }
      const immutableId = String(data.id);
      if (expectedImmutableId && expectedImmutableId !== immutableId) fail('object_mismatch', 'GitHub returned a different immutable issue ID.');
      // Title/body exist only in local process memory to compute this digest.
      const packageDigest = digestPayload(githubIssuePayload(data.title as string, data.body as string | null));
      return Object.freeze({
        destinationAccount: account,
        destinationId: `github:issue:${owner}/${repo}:${number}:${immutableId}`,
        packageDigest,
        observedAt: new Date().toISOString(),
      });
    },
  });
}
