import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppOptions } from '../src/app.js';
import { defaultLangflowConfig } from '../src/langflow-contract.js';

const flowId = 'f74234d2-ec56-4aef-9311-4c748b7969e1';
const otherFlowId = 'cb297649-6bd6-4893-95e4-6b701b448aa3';
const flow = { id: flowId, name: 'Echo', description: 'Returns the prompt', updated_at: '2026-10-01T12:00:00+00:00', data: { nodes: [{ code: 'must never pass through' }] }, credentials: { token: 'private' } };

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function normalFetch(calls: Array<{ url: URL; init?: RequestInit }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, init });
    if (url.pathname.endsWith('/health_check')) return json({ status: 'ok', db: 'ok' });
    if (url.pathname.endsWith('/api/v1/version')) return json({ version: '1.12.5' });
    if (url.pathname.endsWith('/api/v1/flows/')) return json({ items: [flow], total: 1, page: 1, size: 100, pages: 1 });
    if (url.pathname.includes('/flow')) return json({ job_id: 'job-1' });
    if (url.pathname.includes('/events')) {
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: end\ndata: {"outputs":[{"outputs":[{"results":{"message":{"text":"Echo: hello"}}}]}]}\n\n')); c.close(); } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ detail: 'unknown' }, 404);
  }) as typeof fetch;
}

async function setup(t: TestContext, fetcher = normalFetch(), options: Partial<AppOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-langflow-'));
  const app = await createApp({ dataDir: directory, langflowFetch: fetcher, ...options });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, directory };
}

async function saveConfig(app: FastifyInstance, revision: number, config: unknown) {
  return app.inject({ method: 'POST', url: '/api/langflow/config', payload: { revision, config } });
}

async function submit(app: FastifyInstance, input = 'hello', key = 'langflow-test') {
  return app.inject({ method: 'POST', url: '/api/langflow/runs', payload: { flowId, input, idempotencyKey: key } });
}

async function waitForRun(app: FastifyInstance, id: string, status: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await app.inject(`/api/langflow/runs/${id}`);
    if (result.statusCode === 200 && result.json().run.status === status) return result.json().run;
    await delay(5);
  }
  const lastRes = await app.inject(`/api/langflow/runs/${id}`);
  throw new Error(`Timed out waiting for Langflow run ${id} to become ${status}, last status: ${JSON.stringify(lastRes.json())}`);
}

test('Langflow config is loopback-only, revisioned, secret-safe, and saving never probes or runs flows', async t => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const { app, directory } = await setup(t, normalFetch(calls));
  const initial = (await app.inject('/api/langflow/config')).json();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.config, defaultLangflowConfig);
  assert.equal(initial.credentialConfigured, false);

  for (const baseUrl of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://user:pass@127.0.0.1', 'http://127.0.0.1?secret=x']) {
    assert.equal((await saveConfig(app, 0, { ...defaultLangflowConfig, baseUrl })).statusCode, 400, baseUrl);
  }
  assert.equal((await saveConfig(app, 0, { ...defaultLangflowConfig, apiKey: 'secret' })).statusCode, 400);
  assert.equal((await saveConfig(app, 0, { ...defaultLangflowConfig, authMode: 'api-key-env', secretEnv: 'raw-token-value' })).statusCode, 400);
  assert.equal((await saveConfig(app, 0, defaultLangflowConfig)).statusCode, 200);
  assert.equal((await saveConfig(app, 0, defaultLangflowConfig)).statusCode, 409);
  assert.equal(calls.length, 0, 'config writes do not probe or execute');
  const stored = await readFile(join(directory, 'langflow-config.json'), 'utf8');
  assert.equal(JSON.parse(stored).revision, 1);
  assert.equal(calls.filter((call) => call.url.pathname.includes('/api/v1/build/')).length, 0);
});

test('status safely reports offline while core health, settings, roles and mock APIs remain available', async t => {
  const { app } = await setup(t, (async () => { throw new Error('connection refused'); }) as typeof fetch);
  const status = await app.inject('/api/langflow/status');
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().connected, false);
  assert.equal(status.json().version, null);
  assert.doesNotMatch(status.body, /connection refused/);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject('/api/settings')).statusCode, 200);
  assert.equal((await app.inject('/api/roles')).statusCode, 200);
  assert.equal((await app.inject('/api/templates')).statusCode, 200);
});

test('API-key mode injects only the server-side key and flow listing strips graph and credential fields', async t => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const envName = 'AISTUDIO_LANGFLOW_TEST_KEY';
  const previous = process.env[envName];
  process.env[envName] = 'never-persist-this-key';
  t.after(() => { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; });
  const { app, directory } = await setup(t, normalFetch(calls));
  const configured = await saveConfig(app, 0, { ...defaultLangflowConfig, authMode: 'api-key-env', secretEnv: envName });
  assert.equal(configured.statusCode, 200, configured.body);
  assert.equal(configured.json().credentialConfigured, true);
  assert.doesNotMatch(configured.body, /never-persist-this-key/);
  assert.deepEqual((await app.inject('/api/langflow/flows')).json(), {
    flows: [{ id: flowId, name: 'Echo', description: 'Returns the prompt', updatedAt: '2026-10-01T12:00:00+00:00' }],
  });
  const flowRequest = calls.find((call) => call.url.pathname.endsWith('/api/v1/flows/'))!;
  assert.equal(flowRequest.url.searchParams.get('header_flows'), 'true');
  assert.equal(flowRequest.url.searchParams.get('get_all'), 'false');
  assert.equal(flowRequest.url.searchParams.get('page'), '1');
  assert.equal(flowRequest.url.searchParams.get('size'), '100');
  assert.equal((flowRequest.init?.headers as Record<string, string>)['accept-encoding'], 'gzip, deflate, br');
  assert.ok(calls.every(({ init }) => (init?.headers as Record<string, string>)?.['x-api-key'] === 'never-persist-this-key'));
  const stored = await readFile(join(directory, 'langflow-config.json'), 'utf8');
  assert.match(stored, new RegExp(envName));
  assert.doesNotMatch(stored, /never-persist-this-key/);
  assert.doesNotMatch((await app.inject('/api/langflow/config')).body, /never-persist-this-key/);
});

test('native run persists before async dispatch, decodes output, and idempotency replay ignores upstream availability', async t => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  let online = true;
  const fetcher: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, init });
    if (!online) throw new Error('offline');
    if (url.pathname.endsWith('/api/v1/flows/')) return json([flow]);
    if (url.pathname.includes('/flow')) return json({ job_id: 'job-1' });
    if (url.pathname.includes('/events')) {
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: end\ndata: {"outputs":[{"outputs":[{"results":{"message":{"text":"Echo: hello"}}}]}]}\n\n')); c.close(); } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ status: 'ok' });
  }) as typeof fetch;
  const { app, directory } = await setup(t, fetcher);
  const created = await submit(app);
  assert.equal(created.statusCode, 202, created.body);
  const receipt = created.json().run;
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.provider, 'langflow');
  assert.equal('snapshot' in receipt, false);
  const persistedLedger = JSON.parse(await readFile(join(directory, 'langflow-runs.json'), 'utf8'));
  assert.equal(persistedLedger.runs[0].id, receipt.id);
  assert.ok(persistedLedger.runs[0].snapshot);
  const succeeded = await waitForRun(app, receipt.id, 'succeeded');
  assert.equal(succeeded.output, 'Echo: hello');
  const dispatch = calls.find((call) => call.url.pathname.includes('/build/'))!;
  assert.equal(dispatch.url.pathname, `/api/v1/build/${flowId}/flow`);
  assert.equal(dispatch.url.search, '');
  assert.equal(dispatch.init?.redirect, 'manual');
  assert.deepEqual(JSON.parse(String(dispatch.init?.body)), {
    inputs: { input_value: 'hello', input_type: 'chat', output_type: 'chat' }, session_id: `studio-${receipt.id}`,
  });

  online = false;
  const replay = await submit(app);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().run.id, receipt.id);
  const conflict = await submit(app, 'changed', 'langflow-test');
  assert.equal(conflict.statusCode, 409);
  const direct = await app.inject(`/api/langflow/runs/${receipt.id}`);
  assert.equal(direct.statusCode, 200);
  assert.equal((await app.inject('/api/langflow/runs')).json().runs[0].id, receipt.id);
});

test('request validation, redirect rejection, response size cap, and unsupported flow shape are typed safely', async t => {
  let mode: 'normal' | 'redirect' | 'large' | 'shape' = 'normal';
  const fetcher: typeof fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/api/v1/flows/')) {
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://example.com' } });
      if (mode === 'large') return new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200, headers: { 'content-encoding': 'gzip', 'content-length': '128' } });
      if (mode === 'shape') return json({ graph: { code: 'no' } });
      return json([flow]);
    }
    return json({ status: 'ok' });
  }) as typeof fetch;
  const { app } = await setup(t, fetcher);
  assert.equal((await app.inject({ method: 'POST', url: '/api/langflow/runs', payload: { flowId: 'not-uuid', input: 'x', idempotencyKey: 'k' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/langflow/runs', payload: { flowId, input: '  ', idempotencyKey: 'k' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/langflow/runs', payload: { flowId, input: 'x'.repeat(2001), idempotencyKey: 'k' } })).statusCode, 400);
  mode = 'redirect';
  assert.equal((await app.inject('/api/langflow/flows')).json().error.code, 'LANGFLOW_REDIRECT_BLOCKED');
  mode = 'large';
  assert.equal((await app.inject('/api/langflow/flows')).json().error.code, 'LANGFLOW_RESPONSE_TOO_LARGE');
  mode = 'shape';
  assert.equal((await app.inject('/api/langflow/flows')).json().error.code, 'LANGFLOW_RESPONSE_INVALID');
});

test('a body that stalls past timeout becomes outcome_unknown and is not resubmitted', async t => {
  let runCalls = 0;
  const fetcher: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/api/v1/flows/')) return json([flow]);
    if (url.pathname.includes('/flow')) {
      runCalls++;
      return json({ job_id: 'job-stall' });
    }
    if (url.pathname.includes('/events')) {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return json({ status: 'ok' });
  }) as typeof fetch;
  const { app } = await setup(t, fetcher);
  assert.equal((await saveConfig(app, 0, { ...defaultLangflowConfig, timeoutMs: 1000 })).statusCode, 200);
  const created = await submit(app);
  assert.equal(created.statusCode, 202);
  const result = await waitForRun(app, created.json().run.id, 'outcome_unknown');
  assert.match(result.error, /may have executed/);
  await delay(30);
  assert.equal(runCalls, 1);
  assert.equal((await submit(app)).statusCode, 200);
  assert.equal(runCalls, 1);
});

test('decoded output is capped and an unrecognized result shape fails without exposing the upstream object', async t => {
  let outputValue: unknown = { outputs: [{ outputs: [{ results: { message: { text: 'x'.repeat(17_000) } } }] }] };
  const fetcher: typeof fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/api/v1/flows/')) return json([flow]);
    if (url.pathname.endsWith('/flow')) return json({ job_id: 'job-cap' });
    if (url.pathname.includes('/events')) {
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: end\ndata: ' + JSON.stringify(outputValue) + '\n\n')); c.close(); } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ status: 'ok' });
  }) as typeof fetch;
  const { app } = await setup(t, fetcher);
  const cappedReceipt = await submit(app, 'hello', 'cap-output');
  const capped = await waitForRun(app, cappedReceipt.json().run.id, 'succeeded');
  assert.equal(capped.output.length, 16_000);
  assert.equal(capped.error, null);

  outputValue = { outputs: [{ outputs: [{ results: { secret: 'must not leak' } }] }] };
  const invalidReceipt = await submit(app, 'second', 'invalid-result');
  const invalid = await waitForRun(app, invalidReceipt.json().run.id, 'failed');
  assert.match(invalid.error, /unsupported execution response shape/);
  assert.doesNotMatch(JSON.stringify(invalid), /must not leak/);
});

test('restart converts dispatched work to unknown and resumes only durable queued receipts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-langflow-restart-'));
  const runningId = '95c72bdd-884e-45c4-bc7f-402ccaa2e47b';
  const queuedId = 'ee9c9f1b-c479-46ee-9c61-0b22b6b4464f';
  const now = new Date().toISOString();
  const snapshot = { config: defaultLangflowConfig, flow: { id: flowId, name: 'Echo', description: '', updatedAt: null } };
  const fingerprint = (await import('node:crypto')).createHash('sha256').update(JSON.stringify({ flowId, input: 'recover me' })).digest('hex');
  const run = (id: string, status: string, input: string) => ({ id, flowId, flowName: 'Echo', input, status, createdAt: now, updatedAt: now, output: null, error: null, provider: 'langflow', snapshot });
  await writeFile(join(directory, 'langflow-runs.json'), JSON.stringify({
    schemaVersion: 1, runs: [run(runningId, 'running', 'was in flight'), run(queuedId, 'queued', 'recover me')],
    submissions: [
      { key: 'running-key', fingerprint: 'a'.repeat(64), runId: runningId },
      { key: 'queued-key', fingerprint, runId: queuedId },
    ],
  }));
  let app: FastifyInstance | undefined;
  const fetcher: typeof fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/flow')) return json({ job_id: 'job-recover' });
    if (url.pathname.includes('/events')) {
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: end\ndata: {"outputs":[{"outputs":[{"results":{"message":{"text":"recovered"}}}]}]}\n\n')); c.close(); } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ status: 'ok' });
  }) as typeof fetch;
  t.after(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });
  app = await createApp({ dataDir: directory, langflowFetch: fetcher });
  assert.equal((await app.inject(`/api/langflow/runs/${runningId}`)).json().run.status, 'outcome_unknown');
  const recovered = await waitForRun(app, queuedId, 'succeeded');
  assert.equal(recovered.output, 'recovered');
  const replay = await app.inject({ method: 'POST', url: '/api/langflow/runs', payload: { flowId, input: 'recover me', idempotencyKey: 'queued-key' } });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().run.id, queuedId);
  const persisted = JSON.parse(await readFile(join(directory, 'langflow-runs.json'), 'utf8'));
  assert.equal(persisted.runs.find((item: { id: string }) => item.id === runningId).status, 'outcome_unknown');
});

test('a receipt storage failure prevents native dispatch while the core API remains healthy', async t => {
  let dispatches = 0;
  const fetcher: typeof fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/api/v1/flows/')) return json([flow]);
    if (url.pathname.includes('/api/v1/run/')) dispatches++;
    return json({ outputs: [] });
  }) as typeof fetch;
  const { app, directory } = await setup(t, fetcher);
  await mkdir(join(directory, 'langflow-runs.json'));
  const response = await submit(app);
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(dispatches, 0);
  assert.equal((await app.inject('/api/langflow/runs')).statusCode, 503);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject('/api/roles')).statusCode, 200);
});

test('OpenAPI lists Langflow configuration, status, native flow and receipt endpoints', async t => {
  const { app } = await setup(t);
  const spec = (await app.inject('/api/openapi.json')).json();
  assert.ok(spec.paths['/api/langflow/config'].get && spec.paths['/api/langflow/config'].post);
  assert.ok(spec.paths['/api/langflow/status'].get);
  assert.ok(spec.paths['/api/langflow/flows'].get);
  assert.ok(spec.paths['/api/langflow/runs'].get && spec.paths['/api/langflow/runs'].post);
  assert.ok(spec.paths['/api/langflow/runs/{id}'].get);
  assert.equal(spec.paths['/api/langflow/runs'].post.responses[202].description, 'New queued execution receipt');
  assert.equal(spec.components.schemas.LangflowRun.properties.status.enum.includes('outcome_unknown'), true);
  assert.equal(spec.components.schemas.LangflowRun.properties.status.enum.includes('cancelled'), true);
  assert.ok(spec.paths['/api/langflow/runs/{id}/cancel'].post);
});

test('active or queued Langflow run can be cancelled, propagates cancel upstream, and terminal states reject cancel', async (t) => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, init });
    if (url.pathname.endsWith('/api/v1/flows/')) return json([flow]);
    if (url.pathname.includes('/flow')) return json({ job_id: 'job-cancel-test' });
    if (url.pathname.includes('/cancel')) return json({ status: 'cancelled' });
    if (url.pathname.includes('/events')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n'));
          init?.signal?.addEventListener('abort', () => {
            try { controller.close(); } catch {}
          });
        },
        cancel() {},
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ status: 'ok' });
  }) as typeof fetch;

  const { app } = await setup(t, fetcher);
  const created = await submit(app, 'test input', 'key-cancel-1');
  const runId = created.json().run.id;

  const runningRun = await waitForRun(app, runId, 'running');
  assert.equal(runningRun.status, 'running');

  const waitDispatchDeadline = Date.now() + 5000;
  while (!calls.some((c) => c.url.pathname.includes('/events')) && Date.now() < waitDispatchDeadline) {
    await delay(10);
  }
  assert.ok(calls.some((c) => c.url.pathname.includes('/events')), 'job should be dispatched and polling events');

  const cancelRes = await app.inject({ method: 'POST', url: `/api/langflow/runs/${runId}/cancel` });
  assert.equal(cancelRes.statusCode, 200);
  assert.equal(cancelRes.json().run.status, 'cancelled');

  const cancelCall = calls.find((c) => c.url.pathname.includes('/cancel'));
  assert.ok(cancelCall, 'cancel should be dispatched to Langflow');
  assert.equal(cancelCall.url.pathname, '/api/v1/build/job-cancel-test/cancel');

  const repeatCancel = await app.inject({ method: 'POST', url: `/api/langflow/runs/${runId}/cancel` });
  assert.equal(repeatCancel.statusCode, 409);
});
