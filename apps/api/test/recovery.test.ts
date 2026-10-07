import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../src/app.js';
import type { Run, RunNode } from '../src/domain.js';
import { MockProvider, ProviderOutcomeUnknownError, type ProviderOutput } from '../src/provider.js';
import { FileStore } from '../src/store.js';
import { fixture, getRun, submit, waitFor } from './helpers.js';

function childMessage(child: ChildProcess, expected: string): Promise<{ run: Run }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('IPC recovery fixture timed out.')); }, 10000);
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
    const message = (data: { type?: string; run?: Run; message?: string }) => {
      if (data.type === expected && data.run) { cleanup(); resolve({ run: data.run }); }
      else if (data.type === 'error') { cleanup(); reject(new Error(data.message)); }
    };
    const exit = (code: number | null) => { cleanup(); reject(new Error(`Fixture exited before message: ${code}`)); };
    child.on('message', message); child.once('exit', exit); child.once('error', reject);
  });
}

test('real process kill/restart resumes interrupted local mock and preserves successful nodes and idempotency', { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-crash-test-'));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const start = (mode: string) => {
    const child = fork(fileURLToPath(new URL('./restart-worker.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env: { ...process.env, TEST_DATA_DIR: directory, TEST_WORKER_MODE: mode },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(child); return child;
  };
  const first = start('seed');
  const { run: interrupted } = await childMessage(first, 'checkpoint');
  assert.deepEqual(interrupted.nodes.map((node) => node.status), ['succeeded', 'running', 'pending']);
  const durable = JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8')).runs[0];
  assert.deepEqual(durable, interrupted);
  const killed = once(first, 'exit'); first.kill('SIGKILL'); await killed;
  const second = start('resume');
  const exited = once(second, 'exit');
  const { run: recovered } = await childMessage(second, 'recovered');
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(recovered.id, interrupted.id);
  assert.deepEqual(recovered.nodes.map((node) => node.attempts), [1, 2, 1]);
  assert.equal(recovered.assets.length, 2);
  const app = await createApp({ dataDir: directory, mockDelayMs: 1 });
  try {
    const replay = await app.inject({ method: 'POST', url: '/api/runs', payload: { templateId: 'brand-assets', inputs: { prompt: 'Crash-safe mock', count: 2 }, idempotencyKey: 'restart-key' } });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json().run, recovered);
    for (const asset of recovered.assets) assert.equal((await app.inject(asset.url)).statusCode, 200);
  } finally { await app.close(); }
});

test('real process kill/restart resumes an immutable workflow snapshot after its catalogue is republished', { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-workflow-crash-test-'));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const start = (mode: string) => {
    const child = fork(fileURLToPath(new URL('./restart-worker.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env: { ...process.env, TEST_DATA_DIR: directory, TEST_WORKER_MODE: mode },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(child); return child;
  };
  const first = start('workflow-seed');
  const { run: interrupted } = await childMessage(first, 'checkpoint');
  assert.equal(interrupted.templateId.length > 0, true);
  assert.equal(interrupted.workflowSnapshot?.revision, 2);
  assert.equal(interrupted.workflowSnapshot?.nodes.find((node) => node.id === 'image-a')?.kind, 'image');
  assert.equal((interrupted.workflowSnapshot?.nodes.find((node) => node.id === 'image-a') as { config: { width: number } }).config.width, 512);
  assert.equal(interrupted.nodes[0]?.status, 'running');
  const durable = JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8')).runs[0];
  assert.deepEqual(durable, interrupted);
  const workflows = JSON.parse(await readFile(join(directory, 'workflows.json'), 'utf8'));
  const latest = workflows.workflowHistory.filter((workflow: { id: string }) => workflow.id === interrupted.templateId).at(-1);
  assert.equal(latest.revision, 4);
  assert.equal(latest.publishedRevision, 4);
  assert.equal(latest.nodes.find((node: { id: string }) => node.id === 'image-a').config.width, 2048);
  const killed = once(first, 'exit'); first.kill('SIGKILL'); await killed;

  const second = start('workflow-resume');
  const exited = once(second, 'exit');
  const { run: recovered } = await childMessage(second, 'recovered');
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(recovered.id, interrupted.id);
  assert.equal(recovered.workflowSnapshot?.revision, 2);
  assert.equal(recovered.expectedAssetCount, 3);
  assert.deepEqual(recovered.assets.map((asset) => asset.width).sort((a, b) => a - b), [512, 1536, 1536]);
  assert.deepEqual(recovered.nodes.map((node) => node.attempts), [2, 1, 1, 1]);
  const app = await createApp({ dataDir: directory, mockDelayMs: 1 });
  try {
    const replay = await app.inject({ method: 'POST', url: '/api/runs', payload: { templateId: interrupted.templateId, workflowRevision: 2, inputs: interrupted.inputs, idempotencyKey: 'workflow-restart-key' } });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json().run, recovered);
  } finally { await app.close(); }
});

test('failed and cancelled runs persist across graceful restart without rescheduling', async (t) => {
  const { app, directory } = await fixture(t, { mockDelayMs: 50 });
  const failure = await submit(app, 'persist-failure', '[mock:fail-once]');
  await waitFor(app, failure.id, (run) => run.status === 'failed');
  const cancelled = await submit(app, 'persist-cancel');
  await app.inject({ method: 'POST', url: `/api/runs/${cancelled.id}/cancel` });
  const before = (await app.inject('/api/runs')).json().runs;
  await app.close();
  const restarted = await createApp({ dataDir: directory, mockDelayMs: 2 });
  try {
    assert.deepEqual((await restarted.inject('/api/runs')).json().runs, before);
    assert.equal((await getRun(restarted, failure.id)).status, 'failed');
    assert.equal((await getRun(restarted, cancelled.id)).status, 'cancelled');
    assert.equal((await restarted.inject({ method: 'POST', url: `/api/runs/${failure.id}/retry` })).statusCode, 200);
    assert.deepEqual((await waitFor(restarted, failure.id, (run) => run.status === 'succeeded')).nodes.map((node) => node.attempts), [1, 2, 1]);
  } finally { await restarted.close(); }
});

test('queued durable submission resumes on startup', async (t) => {
  const { app, directory } = await fixture(t, { mockDelayMs: 100 });
  const run = await submit(app, 'queued-restart');
  await app.close();
  const store = await FileStore.open(directory);
  await store.transaction((db) => {
    const saved = db.runs[0]!;
    saved.status = 'queued'; saved.assets = [];
    for (const node of saved.nodes) { node.status = 'pending'; node.attempts = 0; }
  });
  await store.close();
  const restarted = await createApp({ dataDir: directory, mockDelayMs: 1 });
  try { assert.equal((await waitFor(restarted, run.id, (item) => item.status === 'succeeded')).assets.length, 2); }
  finally { await restarted.close(); }
});

test('unknown provider outcomes are blocked from automatic replay and retry', async (t) => {
  const { app, directory } = await fixture(t);
  const run = await submit(app, 'unknown');
  await waitFor(app, run.id, (item) => item.status === 'succeeded');
  await app.close();
  const store = await FileStore.open(directory);
  await store.transaction((db) => {
    const saved = db.runs[0]!; saved.status = 'running'; saved.assets = [];
    saved.nodes[1]!.status = 'running'; saved.nodes[2]!.status = 'pending';
  });
  await store.close();
  let calls = 0;
  const provider = {
    mode: 'mock' as const, recovery: 'manual-reconciliation' as const,
    async execute(_run: Run, _node: RunNode, _signal: AbortSignal): Promise<ProviderOutput[]> { calls++; return []; },
  };
  const restarted = await createApp({ dataDir: directory, provider });
  try {
    const failed = await getRun(restarted, run.id);
    assert.equal(failed.status, 'failed'); assert.match(failed.error!, /PROVIDER_OUTCOME_UNKNOWN/);
    const retry = await restarted.inject({ method: 'POST', url: `/api/runs/${run.id}/retry` });
    assert.equal(retry.statusCode, 409); assert.equal(calls, 0);
  } finally { await restarted.close(); }
});

test('single-writer lock refuses concurrent processes/stores and corrupt snapshots are never discarded', async (t) => {
  const { app, directory } = await fixture(t);
  await assert.rejects(createApp({ dataDir: directory }), /live writer/);
  await app.close();
  await writeFile(join(directory, 'runs.json'), '{invalid-json');
  await assert.rejects(createApp({ dataDir: directory }));
  assert.equal(await readFile(join(directory, 'runs.json'), 'utf8'), '{invalid-json');
  await writeFile(join(directory, 'runs.json'), JSON.stringify({ version: 99, runs: [], submissions: [] }));
  await assert.rejects(createApp({ dataDir: directory }));
});

test('uncertain provider timeout is persisted and cannot be resubmitted by retry or restart', async (t) => {
  let calls = 0;
  class UnknownTimeout extends MockProvider {
    override async execute(run: Run, node: RunNode, signal: AbortSignal): Promise<ProviderOutput[]> {
      calls++;
      if (node.kind === 'image') throw new ProviderOutcomeUnknownError('Disconnected after dispatch.');
      return super.execute(run, node, signal);
    }
  }
  const provider = new UnknownTimeout(1);
  const { app, directory } = await fixture(t, { provider });
  const created = await submit(app, 'unknown-timeout');
  const failed = await waitFor(app, created.id, (run) => run.status === 'failed');
  assert.match(failed.error!, /PROVIDER_OUTCOME_UNKNOWN/);
  assert.equal(calls, 2);
  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${created.id}/retry` })).statusCode, 409);
  await app.close();
  const restarted = await createApp({ dataDir: directory, provider });
  try {
    assert.deepEqual(await getRun(restarted, created.id), failed);
    assert.equal((await restarted.inject({ method: 'POST', url: `/api/runs/${created.id}/retry` })).statusCode, 409);
    assert.equal(calls, 2);
  } finally { await restarted.close(); }
});
