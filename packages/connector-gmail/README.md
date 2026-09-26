# @77systems/receipts-gmail

Local read-back Gmail connector for Receipts. Requires Node 20+. It never imports a mail client: the operator injects whatever authenticated Gmail read they trust via `getMessage`, keeping credentials and transport entirely on the operator's side.

```ts
import {createGmailConnector} from '@77systems/receipts-gmail';
import {observeDestination} from '@77systems/receipts-core';
import {digestPayload} from '@77systems/receipts-sdk';
import {randomUUID} from 'node:crypto';

// getMessage: (messageId) => users.messages.get({userId:'me', id:messageId, format:'full'})
const connector = createGmailConnector({account:'you@example.com', getMessage});
const payload = {to:'founder@example.com', subject:'Approved subject', body:'Approved body'}; // canonicalGmailPayload shape
const receipt = await observeDestination(connector, {
  surface:'email-send', attemptId:randomUUID(), actionId:randomUUID(), approvalId:randomUUID(),
  destinationAccount:'you@example.com', packageDigest:digestPayload(payload),
  locator:{messageId}, // The real message id from the send result.
});
```

For guarded writes, use the SDK with the connector configured and reconcile the original attempt instead of generating new action identities. See the root README.

The connector re-reads the sent message and digests `canonicalGmailPayload({to, subject, body, cc?, bcc?, html?})` — the exact approved contract, with `\r\n` normalized, trailing spaces stripped per line, and addresses trimmed, so Gmail's transport formatting cannot break an honest match. A message only binds when it is found in **Sent** (`object_mismatch` otherwise — an existing draft or inbox copy is not an outward write), the `To` header is present, and the digest matches. A missing or unreadable message fails closed with `connector_read_failed`; slow reads abort after `timeoutMs` (default 10s, max 60s). `cc`, `bcc`, and `html` are included in the digest only when the approved payload set them. Caller evidence labels cannot invoke this connector or mint its provenance.

Headers and body exist only in local process memory to compute the digest; the audit holds digests only, never message content, credentials, or provider errors.

Tests run the public Receipts conformance suite plus Gmail-specific Sent-label, account, locator, timeout, and tamper cases.
