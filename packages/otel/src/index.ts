import { trace, SpanStatusCode, type Attributes, type Span, type Tracer } from '@opentelemetry/api';
import { bind, classify, getDefaultStore, observeDestination, type AuditStore, type Binding, type ConnectorRequest, type DestinationConnector, type OutwardWrite, type Receipt, type ReceiptScope } from '@77systems/receipts-core';
import { createReceipts, type ExecutionReceipt, type ReceiptsOptions, type ExecuteOptions, type ReconcileOptions } from '@77systems/receipts-sdk';

const verdicts=new Set(['complete','delivery_unknown','package_unverified','prewrite','DUPLICATE','policy_denied']);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);
function attributes(result:unknown, packageDigest?:string):Attributes {
  const value=result as Partial<Receipt&ExecutionReceipt> | undefined;
  const verdict=value?.verdict??value?.classification?.verdict;
  const source=value?.evidenceSource==='receipts-read'?'receipts-read':'host-supplied';
  return {
    ...(typeof verdict==='string'&&verdicts.has(verdict)?{'receipts.verdict':verdict}:{}),
    'receipts.evidence_source':source,
    ...(digest(value?.packageDigest??packageDigest)?{'receipts.package_digest':value?.packageDigest??packageDigest!}:{}),
    ...(digest(value?.observedPackageDigest)?{'receipts.observed_package_digest':value!.observedPackageDigest!}:{}),
  };
}

/** Optional instrumentation only. No exporter is installed and no network calls are made here. */
export function createReceiptsTelemetry(options:{tracer?:Tracer;store?:AuditStore}={}) {
  const tracer=options.tracer??trace.getTracer('@77systems/receipts-otel','0.3.0');
  const store=options.store??getDefaultStore();
  // Instrumentation failure must not alter verification or permit another write.
  function start(name:string, packageDigest?:string):Span|undefined {
    try{return tracer.startSpan(`receipts.${name}`,{attributes:attributes(undefined,packageDigest)});}catch{return undefined;}
  }
  function end(span:Span|undefined,result:unknown,failed=false,packageDigest?:string):void {
    try {
      span?.setAttributes(attributes(result,packageDigest));
      span?.setStatus({code:failed?SpanStatusCode.ERROR:SpanStatusCode.OK});
    } catch { /* Exporters do not control business outcomes. */ }
    finally {try {span?.end();} catch { /* Always attempt to end the span. */ }}
  }
  function failure(span:Span|undefined,error:unknown):void {
    const verdict=(error as {verdict?:unknown})?.verdict;
    end(span,{verdict:typeof verdict==='string'&&verdicts.has(verdict)?verdict:undefined},true);
    // Never record exceptions: provider messages/stacks can contain credentials and payloads.
  }
  /**
   * receipts.receipt.issue means "a receipt document was returned to the caller": a Receipt
   * from observeDestination, a Binding from bind, or an ExecutionReceipt from execute,
   * reconcile or recheck. It fires once per issued receipt for every verdict (complete,
   * delivery_unknown, package_unverified, prewrite) with OK status; the verdict travels in
   * receipts.verdict, so completions are counted by filtering receipts.verdict = complete.
   * DUPLICATE and policy_denied are thrown errors, not receipts: they mark the outer
   * operation span through failure() and never reach this function. A Binding has no
   * verdict field because bind only succeeds by creating a complete binding.
   */
  function issue(result:Receipt|Binding|ExecutionReceipt):void {
    try {
      const verdict='classification' in result?result.classification.verdict:'verdict' in result?result.verdict:'complete';
      end(start('receipt.issue',result.packageDigest),{...result,verdict});
    } catch { /* A receipt already issued is never withdrawn by instrumentation. */ }
  }
  function sync<T>(name:string,action:()=>T,packageDigest?:string):T {
    const span=start(name,packageDigest);
    try{const result=action();end(span,result,false,packageDigest);return result;}catch(error){failure(span,error);throw error;}
  }
  async function asyncSpan<T>(name:string,action:()=>Promise<T>,packageDigest?:string):Promise<T> {
    const span=start(name,packageDigest);
    try{const result=await action();end(span,result,false,packageDigest);return result;}catch(error){failure(span,error);throw error;}
  }
  return {
    classify(write:OutwardWrite) {return sync('classify',()=>classify(write),write.packageDigest);},
    bind(destinationId:string,packageDigest:string,scope?:ReceiptScope) {
      const result=sync('bind',()=>({...bind(destinationId,packageDigest,store,scope),verdict:'complete' as const}),packageDigest);
      issue(result);return result;
    },
    async observeDestination(connector:DestinationConnector,request:ConnectorRequest) {
      const result=await asyncSpan('observe',()=>observeDestination(connector,request,store),request.packageDigest);
      issue(result);return result;
    },
    /** Wrap the actual SDK boundary, preserving its write guard and approval policy. */
    createClient(clientOptions:Omit<ReceiptsOptions,'store'>={}) {
      const client=createReceipts({...clientOptions,store});
      return {
        store:client.store,
        async execute<T>(input:ExecuteOptions<T>) {
          const result=await asyncSpan('execute',()=>client.execute(input));issue(result);return result;
        },
        async reconcile<T>(input:ReconcileOptions<T>) {
          const result=await asyncSpan('observe',()=>client.reconcile(input));issue(result);return result;
        },
        async recheck<T>(input:ReconcileOptions<T>) {
          const result=await asyncSpan('observe',()=>client.recheck(input));issue(result);return result;
        },
        claimComplete:client.claimComplete.bind(client),
      };
    },
  };
}
