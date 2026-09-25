import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { connectorConformance } from '@77systems/receipts-conformance';
import { digestPayload } from '@77systems/receipts-sdk';
import { createGitHubIssuesConnector, githubAccount, githubIssuePayload, GITHUB_ISSUE_SURFACE } from '../dist/index.js';

const token = 'secret-fixture-token-do-not-retain';
const payload = githubIssuePayload('synthetic title','synthetic body');
const responseData = () => ({id:123456,number:42,repository_url:'https://api.github.com/repos/fixture/test',url:'https://api.github.com/repos/fixture/test/issues/42',...payload});
const request = () => ({surface:GITHUB_ISSUE_SURFACE,attemptId:randomUUID(),actionId:randomUUID(),approvalId:randomUUID(),destinationAccount:githubAccount('fixture','test'),packageDigest:digestPayload(payload),locator:{issueNumber:42}});

connectorConformance('GitHub issues connector', (context) => {
  let state = responseData();
  let writeCount=0, readCount=0;
  let readFailure: string | undefined;
  context.mock.method(globalThis,'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    readCount++;
    assert.equal(String(input),'https://api.github.com/repos/fixture/test/issues/42');
    assert.equal(options?.method,'GET');
    assert.equal(options?.redirect,'error');
    assert.equal(new Headers(options?.headers).get('authorization'),`Bearer ${token}`);
    if (readFailure) throw new Error(readFailure);
    if (!writeCount) return new Response('{}',{status:404});
    return Response.json(state);
  });
  return {
    connector:createGitHubIssuesConnector({owner:'fixture',repo:'test',token}),payload,
    destinationAccount:githubAccount('fixture','test'),destinationId:'github:issue:fixture/test:42:123456',locator:{issueNumber:42},
    write(){writeCount++;},writes(){return writeCount;},reads(){return readCount;},
    changeContent(){state={...state,body:'edited after verification'};},
    setWrongAccount(){state={...state,repository_url:'https://api.github.com/repos/another/test'};},
    setReadFailure(message){readFailure=message;},
  };
}, {connectorVersion:'0.3.0',seed:'github-v0.3.0',evaluationPath:'docs/evaluations/github-0.3.0.json'});

test('GitHub validates the exact object and rejects cross-repository data, pull requests, and changed immutable IDs', async t => {
  let state: Record<string,unknown> = responseData();
  let calls=0;
  t.mock.method(globalThis,'fetch', async () => { calls++;return Response.json(state); });
  const connector=createGitHubIssuesConnector({owner:'Fixture',repo:'Test',token});
  const observed=await connector.read(request());
  assert.equal(observed.destinationId,'github:issue:fixture/test:42:123456');
  assert.equal(observed.packageDigest,digestPayload(payload));
  await assert.rejects(() => connector.read({...request(),destinationAccount:'github:other/test'}),{code:'account_mismatch'});
  assert.equal(calls,1);
  for (const change of [
    {number:43}, {url:'https://api.github.com/repos/other/test/issues/42'},
    {repository_url:'https://api.github.com/repos/other/test'}, {id:-1}, {title:null},
  ]) { state={...responseData(),...change}; await assert.rejects(() => connector.read(request()),{code:'object_mismatch'}); }
  state={...responseData(),pull_request:{url:'https://api.github.com/repos/fixture/test/pulls/42'}};
  await assert.rejects(() => connector.read(request()),{code:'not_a_github_issue'});
  state=responseData();
  await assert.rejects(() => connector.read({...request(),destinationId:'github:issue:fixture/test:42:999'}),{code:'object_mismatch'});
});

test('GitHub aborts slow reads and never exposes raw error content or credentials', async t => {
  t.mock.method(globalThis,'fetch', async (_input: unknown, options: RequestInit) => new Promise<Response>((_resolve,reject) => {
    options.signal?.addEventListener('abort',() => reject(new Error(`${token}: private provider body`)),{once:true});
  }));
  // Keep an event-loop handle alive; AbortSignal.timeout itself is unref'ed in Node.
  const keepAlive=setTimeout(()=>undefined,1000);
  try {
    await assert.rejects(() => createGitHubIssuesConnector({owner:'fixture',repo:'test',token,timeoutMs:10}).read(request()), error => {
      assert.equal((error as {code:string}).code,'github_read_failed');
      assert.ok(!String(error).includes(token));
      assert.ok(!String(error).includes('private provider body'));
      return true;
    });
  } finally {clearTimeout(keepAlive);}
});

test('GitHub rejects unsafe locators before using credentials and normalizes null bodies', async t => {
  let calls=0;
  t.mock.method(globalThis,'fetch', async () => {calls++;return Response.json({...responseData(),body:null});});
  const connector=createGitHubIssuesConnector({owner:'fixture',repo:'test',token});
  for (const issueNumber of ['../other','1?x=token',-1,1.1,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(() => connector.read({...request(),locator:{issueNumber}}),{code:'invalid_locator'});
  }
  assert.equal(calls,0);
  const observed=await connector.read(request());
  assert.equal(observed.packageDigest,digestPayload(githubIssuePayload(payload.title,'')));
});

test('GitHub falls through an empty environment token to GH_TOKEN without overriding an explicit token', async t => {
  const previousGitHub = process.env.GITHUB_TOKEN;
  const previousGh = process.env.GH_TOKEN;
  t.after(() => {
    if (previousGitHub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHub;
    if (previousGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGh;
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, options?: RequestInit) => {
    calls += 1;
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${token}`);
    return Response.json(responseData());
  });
  process.env.GH_TOKEN = token;
  for (const empty of ['', '   ']) {
    process.env.GITHUB_TOKEN = empty;
    const observed = await createGitHubIssuesConnector({ owner: 'fixture', repo: 'test' }).read(request());
    assert.equal(observed.destinationId, 'github:issue:fixture/test:42:123456');
  }
  assert.equal(calls, 2);
  // Explicit configuration remains authoritative, including an invalid empty token.
  await assert.rejects(() => createGitHubIssuesConnector({ owner: 'fixture', repo: 'test', token: '' }).read(request()), { code: 'missing_github_token' });
  assert.equal(calls, 2);
});
