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

## Key management

`generateReceiptKeyPair()` creates an Ed25519 pair locally and returns `{publicKey, privateKey, keyId}` once: the public key as SPKI PEM, the private key as PKCS#8 PEM, and `keyId`, the `sha256:` digest of the public key's SPKI DER. The private key is never audited, never placed in proof JSON, and never saved by this package. If the returned value is lost, generate a new pair.

Store the private key in an OS keychain, a secrets vault, or a file with mode 0600 outside the repository. Never put it in `.env` files, source control, CI logs, or telemetry. Load it at signing time as the PEM string or a `KeyObject`; `signReceipt` accepts either.

`keyId` is the trust anchor. A verifier pins the signer's public key, and therefore its `keyId`, through a separately trusted channel: a signed release, a documented repository file, or an out-of-band exchange. The `signer.publicKey` embedded in a proof is a convenience for matching, never a source of trust; `verifySignedReceipt` rejects any proof whose signer is not the supplied trusted key.

Rotation is a new pair and a new `keyId`, published through the same trusted channel. Existing proofs stay verifiable only under the key that signed them; a verifier that no longer trusts an old `keyId` rejects those proofs. To carry a receipt forward, sign it again with the new key from the same audit store: the receipt and its `observedAt` are unchanged, only the attestation and `signedAt` are new. A verifier decides which `keyId`s it still trusts and for how long; the format carries no expiry.

A verifier with several trusted keys selects the key from its own pinned list by the proof's declared `keyId` before verifying, and treats a `keyId` outside that list as untrusted:

```ts
const trusted = new Map<string, string>([[pinnedKeyId, pinnedPublicKeyPem]]);
const declared = (proof as { signer?: { keyId?: unknown } } | null)?.signer?.keyId;
const publicKey = typeof declared === 'string' ? trusted.get(declared) : undefined;
const result = publicKey
  ? verifySignedReceipt(proof, { trustedPublicKey: publicKey })
  : { valid: false as const, reason: 'invalid_proof' as const };
```

## Key compromise

This package has no revocation protocol, no online key status, no certificate chain, and no timestamping authority. A verifier must maintain its own trusted `keyId` list and treat unknown `keyId`s as untrusted.

If a private key is compromised, remove its `keyId` from that list. That invalidates every proof signed under it, including proofs made before the compromise: `signedAt` is asserted by whoever holds the key, so a signing time cannot separate honest proofs from forged ones once the key is exposed. The underlying receipts and audit chain are unaffected, because the key signs evidence and does not create it. Generate a new pair, publish the new `keyId` through the trusted channel, and sign the still-valid receipts again from the original store. A compromised key must not be used to re-sign anything.

## Format and verification

The JSON format is `receipts-signed/v1` with `algorithm: Ed25519`, a canonical SHA-256 `receiptHash`, the full `audit` snapshot, a `signer` public key and SHA-256 key ID, an ISO `signedAt`, and a canonical base64 signature. Canonical JSON sorts object keys, preserves array order and rejects unsupported values. The signature commits to the complete receipt through its hash and to every audit entry through the signed chain head/count.

`verifySignedReceipt(unknownProof,{trustedPublicKey})` returns `{valid:true,receipt,receiptHash,keyId}` or a generic `{valid:false,reason:'invalid_proof'}`. Tampered receipt content, head, chain, signer, timestamp, or signature fails. The verifier neither fetches a key nor a receipt URL.

All surfaces represented in an audit snapshot must be registered from trusted local code before signing or verification. For GitHub use `import '@77systems/receipts-github'`; importing its definitions performs no read. Unknown surfaces fail closed. Never auto-register schemas from untrusted proof JSON.

A signed snapshot authenticates the named local signer's attestation. It does not add a GitHub signature, independent certification authority, guaranteed completeness beyond that snapshot, or a claim of current destination state. `observedAt` stays historical even if the proof is signed later.

## API

Every function is synchronous and performs no network I/O. `signReceipt` reads the local store; the others read nothing. Surfaces present in the audit snapshot must be registered locally before signing or verifying. Refusals from `signReceipt` and `renderReceiptBadge` are core `ReceiptsError` instances with the `code` values named below; `verifySignedReceipt` never throws.

### `SIGNED_RECEIPT_FORMAT`

The constant `'receipts-signed/v1'`. Compare a proof's `format` against it before handling one; `verifySignedReceipt` rejects any other value.

### `SignedReceipt`

The proof document:

```ts
interface SignedReceipt {
  format: 'receipts-signed/v1';
  algorithm: 'Ed25519';
  receipt: Receipt;                              // Canonicalized copy of the signed receipt.
  receiptHash: string;                           // sha256: digest of the canonical receipt JSON.
  audit: AuditChain;                             // { envelopes, head }: the entire store snapshot at signing time.
  signer: { keyId: string; publicKey: string };  // sha256: of the SPKI DER, and the SPKI PEM.
  signedAt: string;                              // ISO 8601, asserted by the signer.
  signature: string;                             // Canonical base64 Ed25519 signature.
}
```

The signature covers the canonical JSON of `{format, algorithm, receiptHash, auditHead: audit.head, keyId, signedAt}`. The receipt is bound through `receiptHash`; every audit entry is bound through the validated chain ending at the signed head. Treat a parsed proof as untrusted data until `verifySignedReceipt` returns `valid: true`.

### `ProofVerification`

`{valid: true; receipt; receiptHash; keyId} | {valid: false; reason: 'invalid_proof'}`. The failure reason is deliberately generic: it does not distinguish a tampered chain from an untrusted signer, so the verifier cannot be used as an oracle for which field to adjust.

### `generateReceiptKeyPair()`

Returns `{publicKey, privateKey, keyId}` as described under Key management. Call it once per signer identity, store the private key, and publish the public key and `keyId`. It records nothing and does not throw under normal operation.

```ts
const keys = generateReceiptKeyPair();
// keys.publicKey: SPKI PEM. keys.privateKey: PKCS#8 PEM, store it now. keys.keyId: 'sha256:...'
```

### `signReceipt(receipt, {store, privateKey})`

Exports the full audit chain from `store`, validates it, checks that `receipt` matches the audit entry named by `receipt.auditEntryId`, and signs. Call it after a receipt exists (from `getReceipt`, `bind`, `observeDestination`, or the SDK's reconcile path) when you deliberately want a shareable attestation. `privateKey` is a PKCS#8 PEM string or an Ed25519 private `KeyObject`. It returns a `SignedReceipt` and writes nothing.

It throws instead of signing when the store's chain does not validate (core `audit_corrupt`, or `not_a_destination_write` for an unregistered surface); when the entry named by `auditEntryId` is not an observation, recheck, or binding carrying the exact account, action, approval, object, and observation time (`invalid_receipt`); when the supplied receipt differs from that entry (`receipt_audit_mismatch`); or when the key is not an Ed25519 private key (`invalid_signing_key`). A cooperative receipt or a `package_unverified` recheck can be signed; only the badge is limited to independently verified completion.

```ts
const privateKey = loadSigningKeyPem(); // From your keychain or vault, never from a checked-in file.
const proof = signReceipt(receipt, { store, privateKey });
writeFileSync('proof.json', JSON.stringify(proof)); // Review the snapshot before sharing; see Export privacy.
```

### `verifySignedReceipt(proof, {trustedPublicKey})`

Offline verification of an untrusted value. `trustedPublicKey` is the pinned SPKI PEM string or an Ed25519 public `KeyObject`. It returns `ProofVerification` and never throws. `valid: false` covers a malformed or non-canonical document, a `signedAt` that is not the exact ISO form, an untrusted or mismatched signer, a receipt hash mismatch, a bad signature, a chain that fails validation (including an unregistered surface), and a receipt that differs from its audit entry. On success use the returned `receipt`, a canonical copy, and `keyId`, not the raw input.

```ts
const result = verifySignedReceipt(JSON.parse(text), { trustedPublicKey: pinnedPublicKeyPem });
if (!result.valid) throw new Error('Untrusted proof.');
console.log(result.receipt.verdict, result.receipt.independentlyVerified, result.receipt.observedAt);
```

`valid: true` states that the pinned signer attested to this receipt and this audit snapshot. It does not state that the receipt is `complete`, independently verified, or current; read those fields.

### `renderReceiptBadge(proof, {trustedPublicKey, receiptUrl?})`

Verifies the proof with the same rules and returns the static HTML described under Badge spec. Call it only when embedding the independent badge; it is not a general renderer. It throws `badge_requires_independent_completion` when verification fails, the verdict is not `complete`, or `independentlyVerified` is false, and `invalid_receipt_url` when `receiptUrl` is not an HTTPS URL without embedded credentials; an unparsable `receiptUrl` throws Node's `TypeError`. Without `receiptUrl` it returns a `span`; with it, a link.

```ts
const html = renderReceiptBadge(proof, { trustedPublicKey: pinnedPublicKeyPem });
```

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
