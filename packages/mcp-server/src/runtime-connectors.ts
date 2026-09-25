import type { TrustedConnector } from '@77systems/receipts-core';
import { createGitHubIssuesConnector } from '@77systems/receipts-github';

/** Configuration belongs to the local operator, never the MCP request body. */
export function configuredConnectors(): readonly TrustedConnector[] {
  const repo = process.env.RECEIPTS_GITHUB_REPO;
  if (!repo) return [];
  const parts = repo.split('/');
  if (parts.length !== 2) throw new Error('RECEIPTS_GITHUB_REPO must be owner/repo.');
  return [createGitHubIssuesConnector({owner:parts[0]!,repo:parts[1]!})];
}
