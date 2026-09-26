# @77systems/receipts-gmail

Local read-back Gmail connector for Receipts. Requires Node 20+. It never imports a mail client: the operator injects whatever authenticated Gmail read they trust via `getMessage`, keeping credentials and transport entirely on the operator's side.

```ts
import {canonicalGmailPayload, createGmailConnector} from '@77systems/receipts-gmail';
import {observeDestination} from '@77systems/receipts-core';
import {digestPayload} from '@77systems/receipts-sdk';
import {randomUUID} from 'node:crypto';

// getMessage: (messageId) => users.messages.get({userId:'me', id:messageId, format:'full'})
const connector = createGmailConnector({account:'you@example.com', getMessage});
const payload = canonicalGmailPayload({to:'founder@example.com', subject:'Approved subject', body:'Approved body'});
const receipt = await observeDestination(connector, {
  surface:'email-send', attemptId:randomUUID(), actionId:randomUUID(), approvalId:randomUUID(),
  destinationAccount:'you@example.com', packageDigest:digestPayload(payload),
  locator:{messageId}, // The real message id from the send result.
});
```

For guarded writes, use the SDK with the connector configured and reconcile the original attempt instead of generating new action identities. See the root README.

The connector re-reads the sent message and digests `canonicalGmailPayload({to, subject, body, cc?, bcc?, html?})`, which covers everything a recipient can see:

- **Recipients.** `To`, `Cc`, and `Bcc` are read from the Sent copy's headers and reduced to canonical lists (addresses only, lowercased, deduplicated, sorted). Display names and ordering cannot break an honest match; an extra, missing, or unapproved recipient always does, including a Bcc the approval never named.
- **Content.** The subject is trimmed. `body` is the `text/plain` rendering (`''` for HTML-only mail) and `html` is the `text/html` rendering when one is sent; both normalize `\r\n` and trailing whitespace. Approve both renderings when you send a `multipart/alternative` message.
- **Nothing else.** A second text part of either kind, or any other MIME part (attachments, calendar invites, inline images), is outside this contract and prevents a match.

A message only binds when it is found in **Sent** (`object_mismatch` otherwise — an existing draft or inbox copy is not an outward write), has a `To` header, and its digest matches. A mismatch records placement as `package_unverified`. A missing or unreadable message fails closed with `connector_read_failed`; slow reads abort after `timeoutMs` (default 10s, max 60s). `observedAt` is the time of the read, never the message's send time. Caller evidence labels cannot invoke this connector or mint its provenance.

Headers and body exist only in local process memory to compute the digest; the audit holds digests only, never message content, credentials, or provider errors.

Tests run the public Receipts conformance suite plus Gmail-specific Sent-label, account, locator, timeout, tamper, recipient (To/Cc/Bcc), HTML-alternative, attachment, and observation-time cases.
