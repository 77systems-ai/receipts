import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {MemoryAuditStore,observeDestination,createAuditEntry,record,bind,getReceipt,digestPackage} from '@77systems/receipts-core';
import {generateReceiptKeyPair,signReceipt,verifySignedReceipt,renderReceiptBadge} from '../dist/index.js';

async function fixture(){
 const store=new MemoryAuditStore();const packageDigest=digestPackage('secret-content-not-exported');
 const receipt=await observeDestination({surface:'http-post',read:()=>({destinationAccount:'fixture:account',destinationId:'object-proof',packageDigest,observedAt:'2026-09-25T10:00:00.000Z'})},
 {surface:'http-post',attemptId:randomUUID(),actionId:randomUUID(),approvalId:randomUUID(),destinationAccount:'fixture:account',packageDigest},store);
 const keys=generateReceiptKeyPair();return {store,receipt,keys,proof:signReceipt(receipt,{store,privateKey:keys.privateKey})};
}

test('Ed25519 receipt, chain and badge verify entirely offline and include required fields',async t=>{
 const {proof,keys,receipt}=await fixture();
 t.mock.method(globalThis,'fetch',()=>{throw new Error('Verification must be offline.');});
 assert.equal(verifySignedReceipt(proof,{trustedPublicKey:keys.publicKey}).valid,true);
 const markup=renderReceiptBadge(proof,{trustedPublicKey:keys.publicKey,receiptUrl:'https://example.com/proof.json'});
 for(const field of ['Verified by Receipts','independently verified','receipt #','data-receipt-hash','data-signer-key',receipt.observedAt])assert.ok(markup.includes(field));
 assert.ok(!markup.includes('<script'));assert.ok(!markup.includes('<img'));assert.ok(!JSON.stringify(proof).includes(keys.privateKey));assert.ok(!JSON.stringify(proof).includes('secret-content-not-exported'));
});

test('receipt, chain, signed head, signer, time and signature tampering fail offline',async()=>{
 const {proof,keys}=await fixture();
 const changes=[
 (p:any)=>{p.receipt.observedAt='2026-09-25T11:00:00.000Z';},
 (p:any)=>{p.audit.envelopes[0].entry.packageDigest=digestPackage('changed');},
 (p:any)=>{p.audit.envelopes.pop();p.audit.head.count--;p.audit.head.hash=p.audit.envelopes.at(-1).hash;},
 (p:any)=>{p.signer=generateReceiptKeyPair();},
 (p:any)=>{p.signedAt='2026-09-25T12:00:00.000Z';},
 (p:any)=>{p.signature='A'.repeat(86)+'==';},
 (p:any)=>{p.receipt.payload='unapproved extra content';},
 ];
 for(const mutate of changes){const tampered=structuredClone(proof);mutate(tampered);assert.equal(verifySignedReceipt(tampered,{trustedPublicKey:keys.publicKey}).valid,false);}
 assert.equal(verifySignedReceipt(proof,{trustedPublicKey:generateReceiptKeyPair().publicKey}).valid,false);
 assert.equal(verifySignedReceipt(proof,{trustedPublicKey:'invalid-key'}).valid,false);
 assert.equal(verifySignedReceipt(null,{trustedPublicKey:keys.publicKey}).valid,false);
});

test('signer cannot sign a receipt that differs from the stored entry; badge rejects unsafe links',async()=>{
 const {store,receipt,keys,proof}=await fixture();
 assert.throws(()=>signReceipt({...receipt,observedAt:'2026-09-25T11:00:00.000Z'},{store,privateKey:keys.privateKey}));
 for(const receiptUrl of ['javascript:alert(1)','http://example.com/proof','https://user:password@example.com/proof']) assert.throws(()=>renderReceiptBadge(proof,{trustedPublicKey:keys.publicKey,receiptUrl}));
 assert.ok(!renderReceiptBadge(proof,{trustedPublicKey:keys.publicKey,receiptUrl:'https://example.com/?q="onload="x'}).includes('q="onload="'));
});

test('cooperative receipts may be locally signed but cannot display independent badge',()=>{
 const store=new MemoryAuditStore();const packageDigest=digestPackage('fixture');
 const identity={surface:'http-post',attemptId:randomUUID(),actionId:randomUUID(),approvalId:randomUUID(),destinationAccount:'fixture:account',packageDigest,destinationId:'object-host'};
 record(createAuditEntry({...identity,evidence:[{source:'provider',detail:'host attestation',destinationId:identity.destinationId,packageDigest}]},'observation'),store);
 bind(identity.destinationId,packageDigest,store);
 const receipt=getReceipt(identity.destinationId,packageDigest,store)!;const keys=generateReceiptKeyPair();
 const proof=signReceipt(receipt,{store,privateKey:keys.privateKey});
 assert.equal(verifySignedReceipt(proof,{trustedPublicKey:keys.publicKey}).valid,true);
 assert.throws(()=>renderReceiptBadge(proof,{trustedPublicKey:keys.publicKey}));
});
