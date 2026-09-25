# Receipts signed proofs and offline badges

`@77systems/receipts-proof` adds an opt-in Ed25519 signature over a receipt hash, an audit snapshot's head, the signer key ID, format/algorithm, and signing time. Verification recomputes the receipt hash, validates the entire linked audit snapshot and its rules, and checks the exact receipt against its recorded observation/binding.

No server, explorer, network verification call, or blockchain is involved. Keys are generated locally. A trusted public key must come from a separately authenticated source; accepting the key embedded in an unknown proof would only establish that someone signed their own claim.

```ts
import '@77systems/receipts-github'; // Register the known GitHub surface locally; no network/token required.
import {JsonlAuditStore, getReceipt} from '@77systems/receipts-core';
import {generateReceiptKeyPair, signReceipt, verifySignedReceipt, renderReceiptBadge} from '@77systems/receipts-proof';

const store=new JsonlAuditStore('/absolute/local/audit.jsonl');
const receipt=getReceipt(actualDestinationId,approvedDigest,store,{
  destinationAccount:actualAccount,actionId:approvedActionId,
});
if (!receipt) throw new Error('No historical receipt found.');
const keys=generateReceiptKeyPair(); // Or load an existing local Ed25519 key.
const proof=signReceipt(receipt,{store,privateKey:keys.privateKey});
const result=verifySignedReceipt(proof,{trustedPublicKey:keys.publicKey});
const html=renderReceiptBadge(proof,{
  trustedPublicKey:keys.publicKey,
  receiptUrl:'https://your-directory.example/your-opt-in-proof.json',
});
```

The sample uses a newly generated local key; a verifier must obtain the real publisher's expected key through a trusted channel. The private key is returned only to the caller, never placed in proof JSON or audit records. Keep it out of source control and telemetry. Persist it only in a protected local file or key store appropriate to your environment; this package does not silently save keys.

## Format and verification

The JSON format is `receipts-signed/v1` with `algorithm: Ed25519`, a canonical SHA-256 `receiptHash`, the full `audit` snapshot, a `signer` public key and SHA-256 key ID, an ISO `signedAt`, and a canonical base64 signature. Canonical JSON sorts object keys, preserves array order and rejects unsupported values. The signature commits to the complete receipt through its hash and to every audit entry through the signed chain head/count.

`verifySignedReceipt(unknownProof,{trustedPublicKey})` returns `{valid:true,receipt,receiptHash,keyId}` or a generic `{valid:false,reason:'invalid_proof'}`. Tampered receipt content, head, chain, signer, timestamp, or signature fails. The verifier neither fetches a key nor a receipt URL.

All surfaces represented in an audit snapshot must be registered from trusted local code before signing or verification. For GitHub use `import '@77systems/receipts-github'`; importing its definitions performs no read. Unknown surfaces fail closed. Never auto-register schemas from untrusted proof JSON.

A signed snapshot authenticates the named local signer's attestation. It does not add a GitHub signature, independent certification authority, guaranteed completeness beyond that snapshot, or a claim of current destination state. `observedAt` stays historical even if the proof is signed later.

## Badge spec

A badge may say **Verified by Receipts · independently verified · receipt #abc123** only when offline verification succeeds and the bound receipt is `complete` with `independentlyVerified: true`. A cooperative receipt can be signed, but cannot display this independent badge.

`renderReceiptBadge` emits accessible static HTML with:

- The required text and the first 12 hexadecimal characters of the receipt hash as its short reference.
- `data-receipts-format`, full `data-receipt-hash`, `data-signer-key`, and `data-evidence-source` attributes.
- A title containing the original observation time and local signer identity.
- An optional escaped HTTPS link without embedded credentials, or a standalone `span`.

There are no scripts, remote images, tracking pixels, or calls to Receipts. A directory can embed the markup and host its own proof. Markup by itself can be copied; consumers should verify the linked proof against their trusted key. “Receipts Certified” is a separate conformance claim requiring a published evaluation receipt, not a property granted by this badge.

## Export privacy

Signing/exporting is explicit. **The proof includes the entire selected audit snapshot**, including metadata for other actions in that store: account/object/action/approval identifiers, hashes, verdicts and times. New entries contain no payload content or credentials, but legacy records can contain old free text. Review a snapshot before sharing; use dedicated audit stores for proofs you intend to publish. Exporting does not upload it anywhere.
