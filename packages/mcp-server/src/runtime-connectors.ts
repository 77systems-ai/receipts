import { delimiter } from 'node:path';
import type { TrustedConnector } from '@77systems/receipts-core';
import { PACKAGE_VERSION } from './version.js';
import { createGitHubIssuesConnector } from '@77systems/receipts-github';
import { createFileConnector } from '@77systems/receipts-file';
import { createGmailConnector, type GmailMessage, type GmailMessageFetcher } from '@77systems/receipts-gmail';

/** Configuration belongs to the local operator, never the MCP request body. */
export function configuredConnectors(): readonly TrustedConnector[] {
  const connectors: TrustedConnector[] = [];
  const repo = process.env.RECEIPTS_GITHUB_REPO;
  if (repo) {
    const parts = repo.split('/');
    if (parts.length !== 2) throw new Error('RECEIPTS_GITHUB_REPO must be owner/repo.');
    connectors.push(createGitHubIssuesConnector({owner:parts[0]!,repo:parts[1]!}));
  }
  const gmailAccount = process.env.RECEIPTS_GMAIL_ACCOUNT?.trim();
  const gmailToken = process.env.RECEIPTS_GMAIL_TOKEN?.trim();
  if (gmailAccount || gmailToken) {
    if (!gmailAccount) throw new Error('RECEIPTS_GMAIL_ACCOUNT is required alongside RECEIPTS_GMAIL_TOKEN.');
    if (!gmailToken) throw new Error('RECEIPTS_GMAIL_TOKEN is required alongside RECEIPTS_GMAIL_ACCOUNT.');
    const getMessage: GmailMessageFetcher = async (messageId) => {
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { authorization: `Bearer ${gmailToken}`, 'user-agent': `receipts/${PACKAGE_VERSION}` },
        });
      } catch {
        throw new Error('Gmail could not be read.');
      }
      if (response.status !== 200) throw new Error(`Gmail read returned HTTP ${response.status}.`);
      return (await response.json()) as GmailMessage;
    };
    connectors.push(createGmailConnector({ account: gmailAccount, getMessage }));
  }
  const fileAccount = process.env.RECEIPTS_FILE_ACCOUNT?.trim();
  const fileRoots = process.env.RECEIPTS_FILE_ROOTS?.trim();
  if (fileAccount || fileRoots) {
    // Tool calls choose the path, so the server never reads outside explicitly configured roots.
    if (!fileRoots) throw new Error('RECEIPTS_FILE_ROOTS is required to enable the file connector over MCP.');
    connectors.push(createFileConnector({
      ...(fileAccount ? { accountId: fileAccount } : {}),
      roots: fileRoots.split(delimiter).map((s) => s.trim()).filter(Boolean),
    }));
  }
  return connectors;
}
