import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { JsonlAuditStore, getReceipt, classify } from '@77systems/receipts-core';
import { createReceipts, DuplicateWriteError, digestPayload } from '@77systems/receipts-sdk';
import { createGitHubIssuesConnector, GITHUB_ISSUE_SURFACE, githubAccount, githubIssuePayload } from '@77systems/receipts-github';

let stage = 'configuration';
async function main(): Promise<void> {
  if (!process.argv.includes('--live')) {
    process.stdout.write('No GitHub writes made. To run the live acceptance test, set RECEIPTS_TEST_REPO=owner/repo and GITHUB_TOKEN (or GH_TOKEN), then run npm run demo:github -- --live. This creates one synthetic issue, reads it, edits it, and closes it.\n');
    return;
  }
  const repository=process.env.RECEIPTS_TEST_REPO;
  if (!repository || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repository)) throw new Error('Set RECEIPTS_TEST_REPO to an explicitly chosen test repository.');
  const [owner,repo]=repository.split('/') as [string,string];
  const token=process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (!token?.trim()) throw new Error('Set a local GITHUB_TOKEN or GH_TOKEN with issue write access for the test repository.');
  const account=githubAccount(owner,repo);
  const resume=process.argv.includes('--resume');
  if(resume&&!process.env.RECEIPTS_AUDIT_PATH) throw new Error('Resume requires an explicit existing audit path.');
  const auditPath=resolve(process.env.RECEIPTS_AUDIT_PATH ?? `.receipts/github-${randomUUID()}/audit.jsonl`);
  const store=new JsonlAuditStore(auditPath);
  const priorClaims=store.read().filter(entry=>entry.event==='attempt');
  if(resume&&priorClaims.length!==1) throw new Error('Resume needs exactly one original execution claim.');
  if(!resume&&priorClaims.length) throw new Error('Use a fresh audit path or resume the existing action.');
  const prior=priorClaims[0];
  if(resume&&prior?.destinationAccount!==account) throw new Error('The audit belongs to a different repository.');
  const actionId=prior?.actionId??randomUUID(), attemptId=prior?.attemptId??randomUUID(), approvalId=prior?.approvalId??randomUUID();
  const receipts=createReceipts({store,connector:createGitHubIssuesConnector({owner,repo,token})});
  const payload=githubIssuePayload(`[Receipts synthetic test] ${actionId}`,'Synthetic destination-verification fixture. No production data. This issue is created once, independently read, edited to verify historical receipts, and closed.');
  if(prior) assert.equal(digestPayload(payload),prior.packageDigest);
  const base=`https://api.github.com/repos/${owner}/${repo}/issues`;
  const headers={authorization:`Bearer ${token}`,accept:'application/vnd.github+json','content-type':'application/json','X-GitHub-Api-Version':'2026-03-10','user-agent':'receipts-live-example/0.3.0'};
  let writes=0;
  const execution={surface:GITHUB_ISSUE_SURFACE,attemptId,actionId,approvalId,destinationAccount:account,payload,
    execute:async ({payload:approved}:{payload:Readonly<typeof payload>}) => {
      writes++;
      const response=await fetch(base,{method:'POST',headers,body:JSON.stringify(approved),redirect:'error',signal:AbortSignal.timeout(15000)});
      if(response.status!==201) throw new Error('The create request did not return HTTP 201. Inspect the destination before taking further action.');
      // Discard the successful response entirely: recovery cannot use its object number or ID.
      await response.body?.cancel();
      throw new Error('Simulated response loss after GitHub accepted the issue.');
    }};
  stage='execute_once';
  const unknown=prior?{classification:classify(prior),independentlyVerified:false}:await receipts.execute(execution);
  assert.equal(unknown.classification.verdict,'delivery_unknown');
  assert.equal(unknown.independentlyVerified,false);
  stage='duplicate_guard';
  await assert.rejects(()=>receipts.execute({...execution,attemptId:randomUUID()}),DuplicateWriteError);
  assert.equal(writes,resume?0:1);
  // Discovery reads only. A unique fixture marker locates the object; it never creates another one.
  stage='read_discovery';
  let matches: Array<{number:number}> = [];
  for(let read=0;read<5;read++) {
    const listing=await fetch(`${base}?state=all&per_page=100&sort=created&direction=desc`,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(listing.status!==200) throw new Error('Fixture discovery failed. No second issue was created.');
    const items=await listing.json() as Array<{title:string;number:number;pull_request?:unknown}>;
    if(!Array.isArray(items)) throw new Error('GitHub returned an invalid discovery response.');
    matches=items.filter(item=>item.title===payload.title&&!item.pull_request);
    if(matches.length===1) break;
    if(matches.length>1) throw new Error('Fixture discovery is ambiguous.');
    // GitHub's list endpoint may lag creation. Retry only the read, never the write.
    if(read<4) await delay(500*(read+1));
  }
  if(matches.length!==1) throw new Error('Fixture was not found. Resume from the saved audit after inspecting the repository.');
  const number=matches[0]!.number;
  const reconcile={surface:GITHUB_ISSUE_SURFACE,attemptId,payload,locator:{issueNumber:number}};
  stage='independent_read';
  const verified=await receipts.reconcile(reconcile);
  assert.equal(verified.classification.verdict,'complete');
  assert.equal(verified.independentlyVerified,true);
  receipts.claimComplete(verified,{requireIndependent:true});
  const original=getReceipt(verified.destinationId!,verified.packageDigest,store,{destinationAccount:account,actionId});
  assert.ok(original);
  const snapshot=JSON.stringify(original);
  stage='unchanged_recheck';
  const unchanged=await receipts.recheck({...reconcile,destinationId:verified.destinationId!});
  assert.equal(unchanged.classification.verdict,'complete');
  const bytesBeforeEdit=readFileSync(auditPath,'utf8');
  stage='edit_fixture';
  const patch=await fetch(`${base}/${number}`,{method:'PATCH',headers,body:JSON.stringify({body:`${payload.body}\nEdited after the original receipt.`}),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(patch.status!==200) throw new Error('The fixture edit failed. The original receipt remains stored locally.');
  await patch.body?.cancel();
  stage='edited_recheck';
  const changed=await receipts.recheck({...reconcile,destinationId:verified.destinationId!});
  assert.equal(changed.classification.verdict,'package_unverified');
  assert.equal(changed.independentlyVerified,true);
  assert.notEqual(changed.observedPackageDigest,changed.packageDigest);
  assert.equal(JSON.stringify(getReceipt(verified.destinationId!,verified.packageDigest,store,{destinationAccount:account,actionId})),snapshot);
  const audit=readFileSync(auditPath,'utf8');
  assert.ok(audit.startsWith(bytesBeforeEdit));
  for(const secret of [token,payload.title,payload.body]) assert.ok(!audit.includes(secret),'Audit must not contain credentials or issue content.');
  stage='close_fixture';
  const closed=await fetch(`${base}/${number}`,{method:'PATCH',headers,body:JSON.stringify({state:'closed'}),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(closed.status!==200) throw new Error('Verification passed but fixture cleanup failed. Close the synthetic issue manually.');
  const closedIssue=await closed.json() as {state?:string;number?:number};
  assert.equal(closedIssue.state,'closed');
  assert.equal(closedIssue.number,number);
  const report={ok:true,issueUrl:`https://github.com/${owner}/${repo}/issues/${number}`,auditPath,
    checks:{createRequestsThisRun:writes,resumed:resume,duplicateBlocked:true,lostResponse:unknown.classification.verdict,independentRead:verified.independentlyVerified,unchangedRecheck:unchanged.classification.verdict,editedRecheck:changed.classification.verdict,originalReceiptUnchanged:true,auditContentRedacted:true,fixtureClosed:true},
    originalReceipt:original,unchangedRecheck:unchanged,editedRecheck:changed};
  stage='export_receipt';
  const proofPath=resolve(dirname(auditPath),`proof-${actionId}.json`);
  mkdirSync(dirname(proofPath),{recursive:true,mode:0o700});
  writeFileSync(proofPath,`${JSON.stringify(report,null,2)}\n`,{mode:0o600,flag:'wx'});
  process.stdout.write(`${JSON.stringify({...report,proofPath},null,2)}\n`);
}

main().catch(()=>{
  // Do not print arbitrary provider exception messages, credentials, or payloads.
  process.stderr.write(`The live scenario stopped at ${stage}. Do not retry an uncertain write. Inspect the local audit and test repository; use --live --resume with the original RECEIPTS_AUDIT_PATH to continue read-back.\n`);
  process.exitCode=1;
});
