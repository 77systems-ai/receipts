import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { exportAuditChain, validateAuditChain, ReceiptsError, type AuditChain, type AuditEntry, type AuditStore, type Receipt } from '@77systems/receipts-core';

export const SIGNED_RECEIPT_FORMAT = 'receipts-signed/v1' as const;
export interface SignedReceipt {
  format: typeof SIGNED_RECEIPT_FORMAT;
  algorithm: 'Ed25519';
  receipt: Receipt;
  receiptHash: string;
  audit: AuditChain;
  signer: { keyId: string; publicKey: string };
  signedAt: string;
  signature: string;
}
export type ProofVerification = { valid: true; receipt: Receipt; receiptHash: string; keyId: string } | { valid: false; reason: 'invalid_proof' };

/** Canonical JSON is part of the v1 signed format; unknown non-JSON values fail closed. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  }
  throw new ReceiptsError('invalid_receipt', 'Invalid canonical value.');
}
function hash(value: string | Uint8Array): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function key(value: string | KeyObject): KeyObject {
  const result=typeof value==='string'?createPublicKey(value):value.type==='private'?createPublicKey(value):value;
  if(result.asymmetricKeyType!=='ed25519'||result.type!=='public') throw new ReceiptsError('invalid_public_key', 'An Ed25519 public key is required.');
  return result;
}
function keyId(publicKey: KeyObject): string { return hash(publicKey.export({format:'der',type:'spki'})); }
function receiptAt(entry: AuditEntry): Receipt {
  if (!['binding','recheck','observation'].includes(entry.event) || !entry.destinationId || !entry.actionId || !entry.destinationAccount || !entry.approvalId || !entry.observedAt) throw new ReceiptsError('invalid_receipt', 'An exact observed receipt is required.');
  const reference=entry.event==='binding'?entry.evidence.find(item=>item.source==='binding'&&item.destinationId===entry.destinationId&&item.packageDigest===entry.packageDigest)?.reference:entry.id;
  if(!reference) throw new ReceiptsError('invalid_receipt', 'Missing observation reference.');
  return {
    destinationId:entry.destinationId,packageDigest:entry.packageDigest,surface:entry.surface,attemptId:entry.attemptId,
    actionId:entry.actionId,destinationAccount:entry.destinationAccount,approvalId:entry.approvalId,
    observationId:reference,auditEntryId:entry.id,timestamp:entry.timestamp,
    evidenceSource:entry.evidenceSource??'host-supplied',independentlyVerified:entry.evidenceSource==='receipts-read',
    observedAt:entry.observedAt,verdict:entry.verdict,
    ...(entry.observedPackageDigest?{observedPackageDigest:entry.observedPackageDigest}:{}),
  };
}
function validateReceipt(receipt: Receipt, audit: AuditChain): void {
  validateAuditChain(audit);
  const entry=audit.envelopes.find(envelope=>envelope.entry.id===receipt.auditEntryId)?.entry;
  if(!entry || canonical(receiptAt(entry))!==canonical(receipt)) throw new ReceiptsError('receipt_audit_mismatch', 'The receipt does not match its audit entry.');
}
function signingBytes(proof: Omit<SignedReceipt,'signature'>): Buffer {
  return Buffer.from(canonical({format:proof.format,algorithm:proof.algorithm,receiptHash:proof.receiptHash,
    auditHead:proof.audit.head,keyId:proof.signer.keyId,signedAt:proof.signedAt}),'utf8');
}

/** Generates keys locally; the private key is returned only to the caller and is never audited. */
export function generateReceiptKeyPair(): {publicKey:string;privateKey:string;keyId:string} {
  const pair=generateKeyPairSync('ed25519');
  return {publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString(),privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),keyId:keyId(pair.publicKey)};
}

/** Explicit opt-in export. Includes local audit metadata; review before sharing. */
export function signReceipt(receipt: Receipt, options: {store:AuditStore;privateKey:string|KeyObject}): SignedReceipt {
  const audit=exportAuditChain(options.store);
  validateReceipt(receipt,audit);
  const privateKey=typeof options.privateKey==='string'?createPrivateKey(options.privateKey):options.privateKey;
  if(privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519') throw new ReceiptsError('invalid_signing_key', 'An Ed25519 private key is required.');
  const publicKey=key(privateKey);
  const unsigned:Omit<SignedReceipt,'signature'>={format:SIGNED_RECEIPT_FORMAT,algorithm:'Ed25519',receipt:JSON.parse(canonical(receipt)) as Receipt,
    receiptHash:hash(canonical(receipt)),audit,signer:{keyId:keyId(publicKey),publicKey:publicKey.export({type:'spki',format:'pem'}).toString()},signedAt:new Date().toISOString()};
  return {...unsigned,signature:sign(null,signingBytes(unsigned),privateKey).toString('base64')};
}

/** Entirely offline. The expected public key must come from a separately trusted source. */
export function verifySignedReceipt(proof: unknown, options: {trustedPublicKey:string|KeyObject}): ProofVerification {
  try {
    const candidate=proof as SignedReceipt;
    if(!candidate||candidate.format!==SIGNED_RECEIPT_FORMAT||candidate.algorithm!=='Ed25519'||!candidate.signer ||
      typeof candidate.signedAt!=='string'||new Date(candidate.signedAt).toISOString()!==candidate.signedAt ||
      typeof candidate.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(candidate.signature)) throw new Error('Invalid format.');
    if(Buffer.from(candidate.signature,'base64').toString('base64')!==candidate.signature) throw new Error('Non-canonical signature.');
    const trusted=key(options.trustedPublicKey);
    if(candidate.signer.keyId!==keyId(trusted)||keyId(key(candidate.signer.publicKey))!==keyId(trusted)) throw new Error('Untrusted signer.');
    if(hash(canonical(candidate.receipt))!==candidate.receiptHash) throw new Error('Invalid receipt hash.');
    if(!verify(null,signingBytes(candidate),trusted,Buffer.from(candidate.signature,'base64'))) throw new Error('Invalid signature.');
    validateReceipt(candidate.receipt,candidate.audit);
    return {valid:true,receipt:JSON.parse(canonical(candidate.receipt)) as Receipt,receiptHash:candidate.receiptHash,keyId:candidate.signer.keyId};
  } catch { return {valid:false,reason:'invalid_proof'}; }
}

function escape(value: string): string { return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
/** Static, accessible HTML: no scripts, remote images, tracking, or verification requests. */
export function renderReceiptBadge(proof: unknown, options: {trustedPublicKey:string|KeyObject;receiptUrl?:string}): string {
  const trustedPublicKey=key(options.trustedPublicKey); // A malformed trust anchor is its own refusal, not a bad receipt.
  const result=verifySignedReceipt(proof,{trustedPublicKey});
  if(!result.valid||result.receipt.verdict!=='complete'||!result.receipt.independentlyVerified) throw new ReceiptsError('badge_requires_independent_completion', 'A valid independently verified complete receipt is required.');
  const short=result.receiptHash.slice('sha256:'.length, 'sha256:'.length+12);
  const attributes=`class="receipts-badge" data-receipts-format="${SIGNED_RECEIPT_FORMAT}" data-receipt-hash="${escape(result.receiptHash)}" data-signer-key="${escape(result.keyId)}" data-evidence-source="receipts-read"`;
  const content=`Verified by Receipts · independently verified · receipt #${short}`;
  const title=`Observed at ${result.receipt.observedAt}. Locally signed by ${result.keyId}. This badge records a historical observation.`;
  if(options.receiptUrl!==undefined) {
    const url=new URL(options.receiptUrl);
    if(url.protocol!=='https:'||url.username||url.password) throw new ReceiptsError('invalid_receipt_url', 'Badge receipt links must use HTTPS without credentials.');
    return `<a ${attributes} href="${escape(url.href)}" rel="noopener noreferrer" title="${escape(title)}">${content}</a>`;
  }
  return `<span ${attributes} role="img" aria-label="${escape(content)}" title="${escape(title)}">${content}</span>`;
}
