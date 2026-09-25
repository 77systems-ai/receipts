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
 await provider.shutdown();
});

test('span end is attempted even when attribute setters fail',()=>{
 let ended=0;const tracer={startSpan:()=>({setAttributes(){throw new Error('exporter failure');},setStatus(){},end(){ended++;}})};
 const telemetry=createReceiptsTelemetry({tracer:tracer as any});
 assert.equal(telemetry.classify({surface:'http-post',attemptId:'test',packageDigest:digestPackage('fixture')}).verdict,'prewrite');
 assert.equal(ended,1);
});
