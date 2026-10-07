import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MockProvider, type ProviderOutput } from '../src/provider.js';
import type { Run, RunNode } from '../src/domain.js';
import { fixture, getRun, submit, waitFor } from './helpers.js';

test('failed generation retries without redoing a successful brief; concurrent retries schedule once', async (t) => {
  const { app } = await fixture(t, { mockDelayMs: 40 });
  const created = await submit(app, 'failure', 'Brand [mock:fail-once]');
  const failed = await waitFor(app, created.id, (run) => run.status === 'failed');
  assert.deepEqual(failed.nodes.map((node) => node.status), ['succeeded', 'failed', 'pending']);
  assert.match(failed.error!, /Simulated mock failure/);
  const retries = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: `/api/runs/${created.id}/retry` })));
  assert.equal(retries.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(retries.filter((response) => response.statusCode === 409).length, 5);
  const completed = await waitFor(app, created.id, (run) => run.status === 'succeeded');
  assert.deepEqual(completed.nodes.map((node) => node.attempts), [1, 2, 1]);
  assert.equal(completed.error, undefined);
  assert.equal(completed.nodes[1]!.error, undefined);
  assert.equal(completed.assets.length, 2);
  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${created.id}/retry` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${created.id}/cancel` })).statusCode, 409);
});

test('export failure preserves successful generation and exact asset files on retry', async (t) => {
  class FailExportOnce extends MockProvider {
    override async execute(run: Run, node: RunNode, signal: AbortSignal): Promise<ProviderOutput[]> {
      if (node.kind === 'export' && node.attempts === 1) throw new Error('Local mock export failed.');
      return super.execute(run, node, signal);
    }
  }
  const { app, directory } = await fixture(t, { provider: new FailExportOnce(2) });
  const created = await submit(app, 'export');
  const failed = await waitFor(app, created.id, (run) => run.status === 'failed');
  const asset = failed.assets[0]!;
  const path = join(directory, 'assets', created.id, `${asset.id}.svg`);
  const modified = (await stat(path)).mtimeMs;
  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${created.id}/retry` })).statusCode, 200);
  const completed = await waitFor(app, created.id, (run) => run.status === 'succeeded');
  assert.deepEqual(completed.nodes.map((node) => node.attempts), [1, 1, 2]);
  assert.deepEqual(completed.assets, failed.assets);
  assert.equal((await stat(path)).mtimeMs, modified);
});

test('queued cancellation never schedules nodes; active cancellation stops later work and is repeatable', async (t) => {
  const { app } = await fixture(t, { mockDelayMs: 150 });
  const active = await submit(app, 'active');
  await waitFor(app, active.id, (run) => run.nodes[1]!.status === 'running');
  const queued = await submit(app, 'queued');
  const cancel = (id: string) => app.inject({ method: 'POST', url: `/api/runs/${id}/cancel` });
  assert.equal((await cancel(queued.id)).json().run.status, 'cancelled');
  assert.equal((await cancel(active.id)).json().run.status, 'cancelled');
  assert.equal((await cancel(active.id)).statusCode, 200);
  await delay(200);
  const final = await getRun(app, active.id);
  assert.deepEqual(final.nodes.map((node) => node.status), ['succeeded', 'cancelled', 'cancelled']);
  assert.deepEqual(final.nodes.map((node) => node.attempts), [1, 1, 0]);
  assert.equal(final.assets.length, 0);
  assert.deepEqual((await getRun(app, queued.id)).nodes.map((node) => node.attempts), [0, 0, 0]);
  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${active.id}/retry` })).statusCode, 409);
});

test('late provider completion after cancellation never commits assets or successful state', async (t) => {
  class IgnoresAbort extends MockProvider {
    override async execute(run: Run, node: RunNode): Promise<ProviderOutput[]> {
      return super.execute(run, node, new AbortController().signal);
    }
  }
  const { app } = await fixture(t, { provider: new IgnoresAbort(100) });
  const created = await submit(app, 'late');
  await waitFor(app, created.id, (run) => run.nodes[1]!.status === 'running');
  await app.inject({ method: 'POST', url: `/api/runs/${created.id}/cancel` });
  await delay(150);
  const final = await getRun(app, created.id);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.assets.length, 0);
  assert.equal(final.nodes[2]!.attempts, 0);
});

test('failed runs cannot cancel, malformed action body rejected, unknown run returns 404', async (t) => {
  const { app } = await fixture(t);
  const created = await submit(app, 'actions', '[mock:fail-once]');
  await waitFor(app, created.id, (run) => run.status === 'failed');
  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${created.id}/cancel` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${created.id}/retry`, payload: { command: 'anything' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs/00000000-0000-4000-8000-000000000000/retry' })).statusCode, 404);
});
