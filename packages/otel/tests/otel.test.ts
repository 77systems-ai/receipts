import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {BasicTracerProvider,InMemorySpanExporter,SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {MemoryAuditStore,digestPackage} from '@77systems/receipts-core';
import {createReceiptsTelemetry} from '../dist/index.js';

test('OTel verification spans carry verdict/source/digests and exclude content, IDs and exceptions',async()=>{
 const exporter=new InMemorySpanExporter();const provider=new BasicTracerProvider({spanProcessors:[new SimpleSpanProcessor(exporter)]});
 const store=new MemoryAuditStore();const telemetry=createReceiptsTelemetry({store,tracer:provider.getTracer('test')});
 const secret='private-token-and-payload-do-not-export';const packageDigest=digestPackage(secret);
 const request={surface:'http-post',attemptId:randomUUID(),actionId:randomUUID(),approvalId:secret,destinationAccount:secret,packageDigest,destinationId:'object-1'};
 telemetry.classify({...request,writeMayHaveHappened:true,statusFlag:secret,evidence:[{source:'executor',detail:secret}]});
 const receipt=await telemetry.observeDestination({surface:'http-post',read:()=>({destinationAccount:secret,destinationId:'object-1',packageDigest,observedAt:new Date().toISOString()})},request);
 telemetry.bind(receipt.destinationId,packageDigest);
 await assert.rejects(()=>telemetry.observeDestination({surface:'http-post',read:()=>{throw new Error(secret);}},request));
 await provider.forceFlush();
 const spans=exporter.getFinishedSpans();
 for(const name of ['receipts.classify','receipts.observe','receipts.bind','receipts.receipt.issue'])assert.ok(spans.some(span=>span.name===name));
 assert.equal(spans.find(span=>span.name==='receipts.classify')?.attributes['receipts.verdict'],'delivery_unknown');
 assert.equal(spans.find(span=>span.name==='receipts.bind')?.attributes['receipts.evidence_source'],'receipts-read');
 assert.ok(spans.every(span=>span.events.length===0));
 assert.ok(!JSON.stringify(spans.map(span=>({name:span.name,attributes:span.attributes,events:span.events,status:span.status}))).includes(secret));
 assert.ok(spans.some(span=>span.status.code===2));
 const issued=spans.filter(span=>span.name==='receipts.receipt.issue');
 assert.equal(issued.length,2,'observe and bind each issue one receipt; the failed read issues none');
 assert.ok(issued.every(span=>span.attributes['receipts.verdict']==='complete'&&span.attributes['receipts.evidence_source']==='receipts-read'&&span.attributes['receipts.package_digest']===packageDigest&&span.status.code===1));
 await provider.shutdown();
});

test('default telemetry has no exporter and failing instrumentation cannot change a decision',()=>{
 const write={surface:'http-post',attemptId:'attempt',packageDigest:digestPackage('fixture'),writeMayHaveHappened:true};
 assert.equal(createReceiptsTelemetry().classify(write).verdict,'delivery_unknown');
 const tracer={startSpan(){throw new Error('broken exporter');}};
 assert.equal(createReceiptsTelemetry({tracer:tracer as any}).classify(write).verdict,'delivery_unknown');
});

test('instrumented SDK emits policy/duplicate decisions without exception messages',async()=>{
 const exporter=new InMemorySpanExporter();const provider=new BasicTracerProvider({spanProcessors:[new SimpleSpanProcessor(exporter)]});
 const store=new MemoryAuditStore();const telemetry=createReceiptsTelemetry({store,tracer:provider.getTracer('sdk')});
 const input={surface:'http-post',attemptId:randomUUID(),actionId:randomUUID(),approvalId:randomUUID(),destinationAccount:'private-account',payload:{body:'private-body'},execute(){}};
 await assert.rejects(()=>telemetry.createClient({policy:{defaultEffect:'block'}}).execute(input));
 const allowed=telemetry.createClient();await allowed.execute({...input,attemptId:randomUUID()});
 await assert.rejects(()=>allowed.execute({...input,attemptId:randomUUID()}));
 await provider.forceFlush();
 const spans=exporter.getFinishedSpans();assert.ok(spans.some(span=>span.attributes['receipts.verdict']==='policy_denied'));assert.ok(spans.some(span=>span.attributes['receipts.verdict']==='DUPLICATE'));
 assert.ok(!JSON.stringify(spans.map(span=>span.attributes)).includes('private-'));
 // Denials are thrown, not issued: only the allowed execute returned a receipt document.
 const issued=spans.filter(span=>span.name==='receipts.receipt.issue');
 assert.equal(issued.length,1);
 assert.equal(issued[0]?.attributes['receipts.verdict'],'delivery_unknown');
 for(const denied of ['policy_denied','DUPLICATE']){
  const span=spans.find(span=>span.attributes['receipts.verdict']===denied);
  assert.equal(span?.name,'receipts.execute');assert.equal(span?.status.code,2);assert.equal(span?.events.length,0);
 }
 await provider.shutdown();
});

test('claim-time policy denial marks the execute span policy_denied, records one refusal and issues no receipt span',async()=>{
 const exporter=new InMemorySpanExporter();const provider=new BasicTracerProvider({spanProcessors:[new SimpleSpanProcessor(exporter)]});
 const store=new MemoryAuditStore();const telemetry=createReceiptsTelemetry({store,tracer:provider.getTracer('sdk')});
 let executed=0;
 const input={surface:'http-post',attemptId:randomUUID(),actionId:randomUUID(),approvalId:randomUUID(),destinationAccount:'private-account',payload:{body:'private-body'},execute(){executed++;}};
 await assert.rejects(()=>telemetry.createClient({policy:{defaultEffect:'block'}}).execute(input),(error:{code?:unknown;verdict?:unknown})=>error.code==='policy_denied'&&error.verdict==='policy_denied');
 assert.equal(executed,0);
 assert.deepEqual(store.read().map(entry=>entry.event),['policy_denied'],'refused before any reservation existed');
 await provider.forceFlush();
 const spans=exporter.getFinishedSpans();
 assert.equal(spans.length,1);
 assert.equal(spans[0]?.name,'receipts.execute');
 assert.equal(spans[0]?.attributes['receipts.verdict'],'policy_denied');
 assert.equal(spans[0]?.attributes['receipts.evidence_source'],'host-supplied');
 assert.equal(spans[0]?.status.code,2);
 assert.equal(spans[0]?.events.length,0);
 assert.ok(!spans.some(span=>span.name==='receipts.receipt.issue'));
 assert.ok(!JSON.stringify(spans.map(span=>({attributes:span.attributes,status:span.status}))).includes('private-'));
 await provider.shutdown();
});

test('independent observation of changed content issues a package_unverified receipt span with receipts-read provenance',async()=>{
 const exporter=new InMemorySpanExporter();const provider=new BasicTracerProvider({spanProcessors:[new SimpleSpanProcessor(exporter)]});
 const store=new MemoryAuditStore();const telemetry=createReceiptsTelemetry({store,tracer:provider.getTracer('test')});
 const approved=digestPackage('approved-content');const edited=digestPackage('edited-content');
 const request={surface:'http-post',attemptId:randomUUID(),actionId:randomUUID(),approvalId:randomUUID(),destinationAccount:'private-account',packageDigest:approved,destinationId:'private-object'};
 const receipt=await telemetry.observeDestination({surface:'http-post',read:()=>({destinationAccount:'private-account',destinationId:'private-object',packageDigest:edited,observedAt:new Date().toISOString()})},request);
 assert.equal(receipt.verdict,'package_unverified');
 assert.equal(receipt.independentlyVerified,true);
 await provider.forceFlush();
 const spans=exporter.getFinishedSpans();
 const issued=spans.filter(span=>span.name==='receipts.receipt.issue');
 assert.equal(issued.length,1);
 assert.equal(issued[0]?.attributes['receipts.verdict'],'package_unverified');
 assert.equal(issued[0]?.attributes['receipts.evidence_source'],'receipts-read');
 assert.equal(issued[0]?.attributes['receipts.package_digest'],approved);
 assert.equal(issued[0]?.attributes['receipts.observed_package_digest'],edited);
 assert.equal(issued[0]?.status.code,1,'an issued mismatch receipt is a successful operation, not an error');
 assert.equal(spans.find(span=>span.name==='receipts.observe')?.attributes['receipts.verdict'],'package_unverified');
 assert.ok(spans.every(span=>span.events.length===0));
 assert.ok(!JSON.stringify(spans.map(span=>span.attributes)).includes('private-'));
 await provider.shutdown();
});

test('a lost response issues a delivery_unknown receipt span; reconcile and recheck issue their own receipt spans',async()=>{
 const exporter=new InMemorySpanExporter();const provider=new BasicTracerProvider({spanProcessors:[new SimpleSpanProcessor(exporter)]});
 const store=new MemoryAuditStore();const telemetry=createReceiptsTelemetry({store,tracer:provider.getTracer('sdk')});
 const secret='private-provider-error-and-payload';
 let current:string|undefined;
 const connector={surface:'http-post',read:(request:{destinationAccount:string;packageDigest:string})=>({destinationAccount:request.destinationAccount,destinationId:'private-object',packageDigest:current??request.packageDigest,observedAt:new Date().toISOString()})};
 const client=telemetry.createClient({connector});
 const attemptId=randomUUID();const payload={body:secret};
 const lost=await client.execute({surface:'http-post',attemptId,actionId:randomUUID(),approvalId:randomUUID(),destinationAccount:'private-account',payload,execute(){throw new Error(secret);}});
 assert.equal(lost.classification.verdict,'delivery_unknown');
 const reconciled=await client.reconcile({surface:'http-post',attemptId,payload,destinationId:'private-object'});
 assert.equal(reconciled.classification.verdict,'complete');
 current=digestPackage('edited-after-verification');
 const rechecked=await client.recheck({surface:'http-post',attemptId,payload,destinationId:'private-object'});
 assert.equal(rechecked.classification.verdict,'package_unverified');
 await provider.forceFlush();
 const spans=exporter.getFinishedSpans();
 const issued=spans.filter(span=>span.name==='receipts.receipt.issue').map(span=>span.attributes);
 assert.deepEqual(issued.map(attributes=>attributes['receipts.verdict']),['delivery_unknown','complete','package_unverified']);
 assert.deepEqual(issued.map(attributes=>attributes['receipts.evidence_source']),['host-supplied','receipts-read','receipts-read']);
 assert.equal(issued[2]?.['receipts.observed_package_digest'],current);
 const execute=spans.find(span=>span.name==='receipts.execute');
 assert.equal(execute?.attributes['receipts.verdict'],'delivery_unknown');
 assert.equal(execute?.status.code,1,'an uncertain receipt is a returned outcome, not an instrumentation error');
 assert.equal(spans.filter(span=>span.name==='receipts.observe').length,2);
 assert.ok(spans.every(span=>span.events.length===0));
 assert.ok(!JSON.stringify(spans.map(span=>({attributes:span.attributes,status:span.status}))).includes('private-'));
 await provider.shutdown();
});

test('span end is attempted even when attribute setters fail',()=>{
 let ended=0;const tracer={startSpan:()=>({setAttributes(){throw new Error('exporter failure');},setStatus(){},end(){ended++;}})};
 const telemetry=createReceiptsTelemetry({tracer:tracer as any});
 assert.equal(telemetry.classify({surface:'http-post',attemptId:'test',packageDigest:digestPackage('fixture')}).verdict,'prewrite');
 assert.equal(ended,1);
});
