import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, getRun, submit, waitFor } from './helpers.js';
import type { Run } from '../src/domain.js';

test('health, template visibility, specification and JSON errors', async (t) => {
  const { app } = await fixture(t);
  assert.deepEqual((await app.inject('/api/health')).json(), { status: 'ok', mode: 'mock', projectId: 'default', roleStorage: { available: true, mode: 'single-turn-text' }, workflowStorage: { available: true, mode: 'local-file' } });
  const templates = (await app.inject('/api/templates')).json().templates;
  assert.equal(templates.length, 3);
  assert.deepEqual(templates.map((item: { enabled: boolean }) => item.enabled), [true, false, false]);
  const spec = (await app.inject('/api/openapi.json')).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/api/runs/{id}/cancel']);
  assert.ok(spec.paths['/api/roles']);
  assert.ok(spec.paths['/api/roles/{id}/revisions']);
  assert.ok(spec.paths['/api/workflows/{id}/publish']);
  assert.ok(spec.paths['/api/mcp/execute']);
  assert.ok(spec.paths['/api/mcp/journal/{runId}']);
  assert.ok(spec.components.schemas.McpExecuteRequest);
  assert.ok(spec.components.schemas.McpAttempt);
  assert.ok(spec.components.schemas.McpJournal);
  assert.equal(spec.paths['/api/mcp/execute'].post.responses[403].content['application/json'].schema.$ref, '#/components/schemas/McpRejectedResponse');
  assert.equal((await app.inject('/not-found')).json().error.code, 'NOT_FOUND');
  assert.equal((await app.inject(`/api/runs/${randomUUID()}`)).statusCode, 404);
  assert.equal((await app.inject('/api/runs/invalid')).statusCode, 400);
});

test('project-scoped requests require an active registered project', async (t) => {
  const { app } = await fixture(t);
  const unregistered = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-project-id': 'ghost' } });
  assert.equal(unregistered.statusCode, 404);
  assert.equal(unregistered.json().error.code, 'PROJECT_NOT_FOUND');

  const createWithStaleSelection = await app.inject({ method: 'POST', url: '/api/projects', headers: { 'x-project-id': 'ghost' }, payload: { name: 'Created From Stale Selection', revision: 0 } });
  assert.equal(createWithStaleSelection.statusCode, 201);
  const projectId = createWithStaleSelection.json<{ record: { id: string } }>().record.id;
  const deleted = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/delete`, payload: {} });
  assert.equal(deleted.statusCode, 200);

  const afterDelete = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-project-id': projectId } });
  assert.equal(afterDelete.statusCode, 404);
  assert.equal(afterDelete.json().error.code, 'PROJECT_NOT_FOUND');
});

test('concurrent first requests for one project share initialization', async (t) => {
  const { app } = await fixture(t);
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Concurrent Project', revision: 0 } });
  assert.equal(created.statusCode, 201);
  const projectId = created.json<{ record: { id: string } }>().record.id;
  const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'GET', url: '/api/health', headers: { 'x-project-id': projectId } })));
  assert.deepEqual(responses.map((response) => response.statusCode), Array(8).fill(200));
  assert.ok(responses.every((response) => response.json().projectId === projectId));
});

test('MCP mock execution persists the completed governance attempt', async (t) => {
  const { app } = await fixture(t);
  const runId = randomUUID();
  const response = await app.inject({
    method: 'POST',
    url: '/api/mcp/execute',
    payload: {
      runId,
      nodeId: 'node-1',
      roleId: 'architect',
      toolName: 'context.search',
      parameters: { query: 'demo' },
      currentStepCount: 1,
      currentToolCallCount: 0,
      currentCost: 0,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().attempt.status, 'succeeded');

  const journal = await app.inject(`/api/mcp/journal/${runId}`);
  assert.equal(journal.statusCode, 200);
  assert.equal(journal.json().attempts[0].status, 'succeeded');
});

test('strict input validation, disabled templates, malformed/oversized JSON and no arbitrary nodes', async (t) => {
  const { app } = await fixture(t);
  const valid = { templateId: 'brand-assets', inputs: { prompt: 'x', count: 1 }, idempotencyKey: 'input' };
  const invalid: unknown[] = [
    {}, null, [], { ...valid, inputs: { prompt: '', count: 1 } },
    ...['   ', 'x'.repeat(2001), 2].map((prompt) => ({ ...valid, inputs: { prompt, count: 1 } })),
    ...[0, 9, 1.5, '2', null].map((count) => ({ ...valid, inputs: { prompt: 'x', count } })),
    { ...valid, idempotencyKey: '' }, { ...valid, idempotencyKey: '../secret' },
    { ...valid, nodes: [{ kind: 'shell', command: 'echo forbidden' }] },
    { ...valid, inputs: { ...valid.inputs, apiUrl: 'http://example.test' } },
  ];
  for (const payload of invalid) {
    const response = await app.inject({ method: 'POST', url: '/api/runs', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'INVALID_INPUT');
  }
  for (const templateId of ['missing', 'video-story', 'coding-assistant']) {
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { ...valid, templateId } });
    assert.equal(response.statusCode, templateId === 'missing' ? 404 : 409);
  }
  const malformed = await app.inject({ method: 'POST', url: '/api/runs', headers: { 'content-type': 'application/json' }, payload: '{broken' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, 'INVALID_JSON');
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs', headers: { 'content-type': 'application/json' }, payload: 'x'.repeat(17000) })).statusCode, 413);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs', headers: { 'content-type': 'application/xml' }, payload: '<run/>' })).statusCode, 415);
  const run = await submit(app, 'trim', '  trimmed prompt  ', 8);
  assert.equal(run.inputs.prompt, 'trimmed prompt');
  const completed = await waitFor(app, run.id, (item) => item.status === 'succeeded');
  assert.equal(completed.assets.length, 8);
});

test('concurrent identical requests create exactly one durable run; conflicting input returns 409', async (t) => {
  const { app, directory } = await fixture(t, { mockDelayMs: 30 });
  const payload = { templateId: 'brand-assets', inputs: { prompt: '  Same brand  ', count: 1 }, idempotencyKey: 'concurrent' };
  const responses = await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: 'POST', url: '/api/runs', payload })));
  assert.equal(responses.filter((response) => response.statusCode === 201).length, 1);
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 11);
  const ids = responses.map((response) => response.json().run.id);
  assert.equal(new Set(ids).size, 1);
  const snapshot = JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8'));
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.submissions.length, 1);
  const replay = await app.inject({ method: 'POST', url: '/api/runs', payload: { ...payload, inputs: { prompt: 'Same brand', count: 1 } } });
  assert.equal(replay.statusCode, 200);
  for (const inputs of [{ prompt: 'Different', count: 1 }, { prompt: 'Same brand', count: 2 }]) {
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { ...payload, inputs } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'IDEMPOTENCY_CONFLICT');
  }
  await waitFor(app, ids[0]!, (run) => run.status === 'succeeded');
  assert.deepEqual((await getRun(app, ids[0]!)).nodes.map((node) => node.attempts), [1, 1, 1]);
});

test('mock output is local, zero-cost, escaped, downloadable and persisted before public success', async (t) => {
  const { app, directory } = await fixture(t);
  const created = await submit(app, 'asset', '<script>alert("x")</script> & logo', 2);
  assert.equal(created.status, 'queued');
  assert.deepEqual(created.nodes.map((node) => node.status), ['pending', 'pending', 'pending']);
  const run = await waitFor(app, created.id, (item) => item.status === 'succeeded');
  assert.equal(run.mode, 'mock'); assert.equal(run.actualCost, 0); assert.equal(run.estimatedCost, 0);
  assert.deepEqual(run.nodes.map((node) => node.status), ['succeeded', 'succeeded', 'succeeded']);
  for (const asset of run.assets) {
    assert.equal(asset.mode, 'mock'); assert.equal(asset.runId, run.id);
    const response = await app.inject(asset.url);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /MOCK DEMO/);
    assert.match(response.body, /NOT AI GENERATED/);
    assert.ok(!response.body.includes('<script>'));
    assert.match(response.body, /&lt;script&gt;/);
    const downloaded = await app.inject(`${asset.url}?download=1`);
    assert.match(downloaded.headers['content-disposition'] as string, /^attachment/);
    assert.equal(downloaded.body, response.body);
    assert.equal(await readFile(join(directory, 'assets', run.id, `${asset.id}.svg`), 'utf8'), response.body);
  }
  const persisted = JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8')).runs[0];
  assert.equal(persisted.status, 'succeeded');
  assert.deepEqual(persisted.assets, run.assets);
  const history = (await app.inject('/api/runs')).json<{ runs: Run[] }>().runs;
  assert.equal(history[0]!.id, run.id);
});

test('CORS is an exact allowlist, Host is local, preflight constrained, correlation ID sanitized', async (t) => {
  const { app } = await fixture(t);
  const good = await app.inject({ url: '/api/health', headers: { origin: 'http://localhost:5173', 'x-request-id': 'test-correlation' } });
  assert.equal(good.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(good.headers['x-request-id'], 'test-correlation');
  for (const origin of ['https://evil.test', 'http://localhost:5173.evil.test', 'null']) {
    const response = await app.inject({ url: '/api/health', headers: { origin } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await app.inject({ url: '/api/health', headers: { host: 'evil.test' } })).statusCode, 403);
  assert.notEqual((await app.inject({ url: '/api/health', headers: { 'x-request-id': 'bad id' } })).headers['x-request-id'], 'bad id');
  const preflight = (method: string, headers = 'content-type,x-request-id') => app.inject({ method: 'OPTIONS', url: '/api/runs', headers: { origin: 'http://localhost:5173', 'access-control-request-method': method, 'access-control-request-headers': headers } });
  assert.equal((await preflight('POST')).statusCode, 204);
  assert.equal((await preflight('DELETE')).statusCode, 403);
  assert.equal((await preflight('POST', 'authorization')).statusCode, 403);
});

test('file serving rejects traversal, unregistered assets and symlinks', async (t) => {
  const { app, directory } = await fixture(t);
  const run = await submit(app, 'path');
  const completed = await waitFor(app, run.id, (item) => item.status === 'succeeded');
  for (const url of [
    `/api/assets/${run.id}/../../runs.json`, `/api/assets/${run.id}/%2e%2e%2fruns.json`,
    `/api/assets/${run.id}/${'0'.repeat(24)}`, `/api/assets/${run.id}/%00`,
  ]) assert.ok((await app.inject(url)).statusCode >= 400, url);
  const asset = completed.assets[0]!;
  const path = join(directory, 'assets', run.id, `${asset.id}.svg`);
  await unlink(path);
  try {
    await symlink(join(directory, 'runs.json'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') {
      t.skip('Symlink creation requires elevated privileges on Windows');
      return;
    }
    throw error;
  }
  const response = await app.inject(asset.url);
  assert.equal(response.statusCode, 404);
  assert.ok(!response.body.includes('submissions'));
});
