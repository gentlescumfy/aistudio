import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { FileStore } from '../src/store.js';
import { MockProvider, type ProviderOutput } from '../src/provider.js';
import type { Run, RunNode } from '../src/domain.js';
import { fixture, getRun, submit, waitFor } from './helpers.js';

test('failed submission persistence never invokes provider and further writes fail closed', async (t) => {
  let calls = 0;
  class CountingProvider extends MockProvider {
    override async execute(run: Run, node: RunNode, signal: AbortSignal): Promise<ProviderOutput[]> {
      calls++; return super.execute(run, node, signal);
    }
  }
  const { app, directory } = await fixture(t, { provider: new CountingProvider(1) });
  const path = join(directory, 'runs.json');
  await rename(path, `${path}.backup`); await mkdir(path);
  try {
    const request = { method: 'POST' as const, url: '/api/runs', payload: { templateId: 'brand-assets', inputs: { prompt: 'failure', count: 1 }, idempotencyKey: 'storage-failure' } };
    assert.equal((await app.inject(request)).statusCode, 500);
    assert.equal((await app.inject(request)).statusCode, 503);
    assert.equal((await app.inject('/api/health')).statusCode, 503);
    await delay(15);
    assert.equal(calls, 0);
    assert.deepEqual((await app.inject('/api/runs')).json().runs, []);
    assert.deepEqual(JSON.parse(await readFile(`${path}.backup`, 'utf8')).submissions, []);
  } finally { await rm(path, { recursive: true }); await rename(`${path}.backup`, path); }
});

test('background persistence failure stops scheduling and safe local mock can recover after storage repair', async (t) => {
  let directory = '';
  let calls = 0;
  class BreakStorage extends MockProvider {
    override async execute(run: Run, node: RunNode, signal: AbortSignal): Promise<ProviderOutput[]> {
      calls++;
      const result = await super.execute(run, node, signal);
      const path = join(directory, 'runs.json');
      await rename(path, `${path}.backup`); await mkdir(path);
      return result;
    }
  }
  const fixtureResult = await fixture(t, { provider: new BreakStorage(10) });
  const app = fixtureResult.app; directory = fixtureResult.directory;
  const created = await submit(app, 'background-storage');
  const path = join(directory, 'runs.json');
  try {
    const deadline = Date.now() + 3000;
    while ((await app.inject('/api/health')).statusCode === 200 && Date.now() < deadline) await delay(5);
    assert.equal((await app.inject('/api/health')).statusCode, 503);
    assert.equal(calls, 1);
    const interrupted = await getRun(app, created.id);
    assert.equal(interrupted.status, 'running');
    assert.equal(interrupted.nodes[0]!.status, 'running');
  } finally { await rm(path, { recursive: true }); await rename(`${path}.backup`, path); await app.close(); }
  const restarted = await createApp({ dataDir: directory, mockDelayMs: 1 });
  try { assert.deepEqual((await waitFor(restarted, created.id, (run) => run.status === 'succeeded')).nodes.map((node) => node.attempts), [2, 1, 1]); }
  finally { await restarted.close(); }
});

test('transactions roll back domain validation failures without losing other submissions', async (t) => {
  const { app, directory } = await fixture(t);
  const run = await submit(app, 'rollback');
  await waitFor(app, run.id, (item) => item.status === 'succeeded');
  await app.close();
  const store = await FileStore.open(directory);
  try {
    const before = store.snapshot();
    await assert.rejects(store.transaction((db) => { db.runs[0]!.actualCost = 10 as 0; }));
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8')), before);
    await store.transaction((db) => { db.runs[0]!.inputs.prompt = 'Still writable'; });
    assert.equal(store.snapshot().runs[0]!.inputs.prompt, 'Still writable');
  } finally { await store.close(); }
});
