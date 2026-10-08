import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import type { Run, RunNode } from '../src/domain.js';
import { MockProvider, type ProviderOutput } from '../src/provider.js';
import type { Workflow, WorkflowDefinition } from '../src/workflow-contract.js';
import { fixture, getRun, waitFor } from './helpers.js';

function branchDefinition(): WorkflowDefinition {
  return {
    name: 'Branching product concepts', description: 'Two independent local SVG branches.',
    nodes: [
      { id: 'image-b', name: 'Wide concept', position: { x: 500, y: 320 }, kind: 'image', config: { width: 1536, height: 1024, count: null } },
      { id: 'export', name: 'Export all concepts', position: { x: 800, y: 200 }, kind: 'export', config: {} },
      { id: 'brief', name: 'Prepare visual brief', position: { x: 100, y: 200 }, kind: 'prompt', config: { template: 'Mock image brief: {{prompt}}. Batch {{count}}.', roleRef: { id: 'architect', revision: 1 } } },
      { id: 'image-a', name: 'Square concept', position: { x: 500, y: 80 }, kind: 'image', config: { width: 512, height: 768, count: 1 } },
    ],
    edges: [
      { id: 'brief-to-a', source: 'brief', target: 'image-a' }, { id: 'brief-to-b', source: 'brief', target: 'image-b' },
      { id: 'b-to-export', source: 'image-b', target: 'export' }, { id: 'a-to-export', source: 'image-a', target: 'export' },
    ],
  };
}

async function createAndPublish(app: Awaited<ReturnType<typeof createApp>>, workflow = branchDefinition()) {
  const createdResponse = await app.inject({ method: 'POST', url: '/api/workflows', payload: { revision: 0, workflow } });
  assert.equal(createdResponse.statusCode, 201, createdResponse.body);
  const created = createdResponse.json<{ revision: number; workflow: { id: string; revision: number } }>();
  const publishedResponse = await app.inject({ method: 'POST', url: `/api/workflows/${created.workflow.id}/publish`, payload: { revision: created.revision } });
  assert.equal(publishedResponse.statusCode, 200, publishedResponse.body);
  return publishedResponse.json<{ revision: number; workflow: Workflow }>();
}

test('workflow catalogue CRUD uses optimistic revisions and immutable persisted snapshots', async (t) => {
  const { app, directory } = await fixture(t);
  const workflow = branchDefinition();
  const create = await app.inject({ method: 'POST', url: '/api/workflows', payload: { revision: 0, workflow } });
  assert.equal(create.statusCode, 201);
  const first = create.json<{ revision: number; workflow: { id: string; revision: number } }>();
  const concurrent = await Promise.all([
    app.inject({ method: 'POST', url: '/api/workflows', payload: { revision: 1, workflow } }),
    app.inject({ method: 'POST', url: '/api/workflows', payload: { revision: 1, workflow } }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [201, 409]);
  const edit = await app.inject({ method: 'POST', url: `/api/workflows/${first.workflow.id}`, payload: { revision: 2, workflow: { ...workflow, name: 'Edited branch' } } });
  assert.equal(edit.statusCode, 200);
  assert.equal(edit.json().workflow.revision, 2);
  assert.equal((await app.inject({ method: 'POST', url: `/api/workflows/${first.workflow.id}/publish`, payload: { revision: 3 } })).statusCode, 200);
  const archive = await app.inject({ method: 'POST', url: `/api/workflows/${first.workflow.id}/archive`, payload: { revision: 4 } });
  assert.equal(archive.statusCode, 200);
  const repeat = await app.inject({ method: 'POST', url: `/api/workflows/${first.workflow.id}/archive`, payload: { revision: 5 } });
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.json().revision, 5);
  assert.equal((await app.inject('/api/templates')).json().templates.some((item: { id: string }) => item.id === first.workflow.id), false);
  const revisions = (await app.inject(`/api/workflows/${first.workflow.id}/revisions`)).json().revisions;
  assert.deepEqual(revisions.map((record: { revision: number }) => record.revision), [1, 2, 3, 4]);
  await app.close();
  const restarted = await createApp({ dataDir: directory, mockDelayMs: 1 });
  try {
    const restored = (await restarted.inject('/api/workflows')).json();
    assert.equal(restored.revision, 5);
    assert.equal(restored.workflows[0].lifecycle, 'archived');
    assert.equal((await restarted.inject(`/api/workflows/${first.workflow.id}/revisions`)).json().revisions.length, 4);
  } finally { await restarted.close(); }
});

test('validation enforces graph topology, safe placeholders, limits and role annotation availability', async (t) => {
  const { app } = await fixture(t);
  const valid = branchDefinition();
  const validation = await app.inject({ method: 'POST', url: '/api/workflows/validate', payload: { workflow: valid } });
  assert.equal(validation.statusCode, 200);
  assert.equal(validation.json().valid, true);
  assert.match(validation.json().warnings.join(' '), /模板处理/);

  const unknownPlaceholder = structuredClone(valid);
  (unknownPlaceholder.nodes.find((node) => node.id === 'brief') as Extract<WorkflowDefinition['nodes'][number], { kind: 'prompt' }>).config.template = '{{prompt}} {{danger}}';
  const unsafe = await app.inject({ method: 'POST', url: '/api/workflows/validate', payload: { workflow: unknownPlaceholder } });
  assert.equal(unsafe.json().valid, false);
  assert.ok(unsafe.json().issues.some((issue: { code: string }) => issue.code === 'UNKNOWN_PLACEHOLDER'));
  const cycle = structuredClone(valid);
  cycle.edges.push({ id: 'cycle-export-brief', source: 'export', target: 'brief' });
  const invalidCycle = await app.inject({ method: 'POST', url: '/api/workflows/validate', payload: { workflow: cycle } });
  assert.ok(invalidCycle.json().issues.some((issue: { code: string }) => issue.code === 'CYCLE'));
  const missingRole = structuredClone(valid);
  const prompt = missingRole.nodes.find((node) => node.id === 'brief') as Extract<WorkflowDefinition['nodes'][number], { kind: 'prompt' }>;
  prompt.config.roleRef = { id: 'missing-role', revision: 9 };
  assert.ok((await app.inject({ method: 'POST', url: '/api/workflows/validate', payload: { workflow: missingRole } })).json().issues.some((issue: { code: string }) => issue.code === 'ROLE_REVISION_NOT_FOUND'));
  const roleLibrary = (await app.inject('/api/roles')).json();
  const { id: _id, revision: _revision, builtIn: _builtIn, lifecycle: _lifecycle, createdAt: _createdAt, updatedAt: _updatedAt, modelStatus: _modelStatus, ...roleDefinition } = roleLibrary.roles.find((role: { id: string }) => role.id === 'architect');
  const custom = await app.inject({ method: 'POST', url: '/api/roles', payload: { revision: 0, role: roleDefinition } });
  const customResult = custom.json<{ revision: number; role: { id: string; revision: number } }>();
  const editedRole = await app.inject({ method: 'POST', url: `/api/roles/${customResult.role.id}`, payload: { revision: customResult.revision, role: roleDefinition } });
  const editedResult = editedRole.json<{ revision: number }>();
  await app.inject({ method: 'POST', url: `/api/roles/${customResult.role.id}/archive`, payload: { revision: editedResult.revision } });
  const archivedReference = structuredClone(valid);
  (archivedReference.nodes.find((node) => node.id === 'brief') as Extract<WorkflowDefinition['nodes'][number], { kind: 'prompt' }>).config.roleRef = { id: customResult.role.id, revision: 1 };
  const invalidArchivedRole = await app.inject({ method: 'POST', url: '/api/workflows/validate', payload: { workflow: archivedReference } });
  assert.ok(invalidArchivedRole.json().issues.some((issue: { code: string }) => issue.code === 'ROLE_CURRENT_ARCHIVED'));
  const invalidDefinition = { ...valid, nodes: valid.nodes.map((node) => ({ ...node, kind: node.kind === 'prompt' ? 'shell' : node.kind })) };
  const rejected = await app.inject({ method: 'POST', url: '/api/workflows', payload: { revision: 0, workflow: invalidDefinition } });
  assert.equal(rejected.statusCode, 400);
});

test('published branching workflow snapshots role annotations and drives real SVG dimensions, prompts, node counts and export sum', async (t) => {
  const { app } = await fixture(t);
  const published = await createAndPublish(app);
  const record = published.workflow;
  assert.equal(record.publishedRevision, record.revision);
  assert.equal(record.roleSnapshots.length, 1);
  assert.equal(record.roleSnapshots[0]!.nodeId, 'brief');
  assert.equal(record.roleSnapshots[0]!.role.id, 'architect');
  const templates = (await app.inject('/api/templates')).json().templates;
  const projected = templates.find((template: { id: string }) => template.id === record.id);
  assert.equal(projected.enabled, true);
  assert.equal(projected.source, 'workflow');
  assert.equal(projected.workflowRevision, record.revision);

  const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { templateId: record.id, workflowRevision: record.revision, inputs: { prompt: 'Museum identity', count: 2 }, idempotencyKey: 'workflow-branch' } });
  assert.equal(response.statusCode, 201, response.body);
  const created = response.json<{ run: Run }>().run;
  assert.equal(created.templateId, record.id);
  assert.equal(created.workflowSnapshot?.revision, record.revision);
  assert.equal(created.expectedAssetCount, 3);
  assert.deepEqual(created.nodes.map((node) => node.id), ['brief', 'image-a', 'image-b', 'export']);
  assert.equal(created.nodes[0]?.outputPrompt, 'Mock image brief: Museum identity. Batch 2.');
  assert.equal(created.nodes.find((node) => node.id === 'image-a')?.outputPrompt, created.nodes[0]?.outputPrompt);
  assert.equal(created.nodes.find((node) => node.id === 'image-b')?.outputPrompt, created.nodes[0]?.outputPrompt);
  const completed = await waitFor(app, created.id, (run) => run.status === 'succeeded');
  assert.equal(completed.assets.length, 3);
  assert.equal(new Set(completed.assets.map((asset) => asset.id)).size, 3);
  assert.deepEqual(completed.assets.map((asset) => asset.nodeId).sort(), ['image-a', 'image-b', 'image-b']);
  const aAsset = completed.assets.find((asset) => asset.nodeId === 'image-a')!;
  const bAsset = completed.assets.find((asset) => asset.nodeId === 'image-b')!;
  assert.deepEqual([aAsset.width, aAsset.height], [512, 768]);
  assert.deepEqual([bAsset.width, bAsset.height], [1536, 1024]);
  assert.match((await app.inject(aAsset.url)).body, /width="512" height="768" viewBox="0 0 512 768"/);
  assert.match((await app.inject(bAsset.url)).body, /Mock image brief: Museum identity\. Batch 2\./);
});

test('failed branch retry preserves completed branch and idempotency replays its original published snapshot after publish and archive', async (t) => {
  class FailBranchOnce extends MockProvider {
    private failed = false;
    override async execute(run: Run, node: RunNode, signal: AbortSignal): Promise<ProviderOutput[]> {
      if (node.id === 'image-b' && !this.failed) { this.failed = true; throw new Error('Branch B mock failure.'); }
      return super.execute(run, node, signal);
    }
  }
  const { app } = await fixture(t, { provider: new FailBranchOnce(1) });
  const firstPublished = await createAndPublish(app);
  const request = { templateId: firstPublished.workflow.id, workflowRevision: firstPublished.workflow.revision, inputs: { prompt: 'Immutable graph', count: 2 }, idempotencyKey: 'snapshot-replay' };
  const created = (await app.inject({ method: 'POST', url: '/api/runs', payload: request })).json<{ run: Run }>().run;
  const failed = await waitFor(app, created.id, (run) => run.status === 'failed');
  const successfulBranch = failed.assets.find((asset) => asset.nodeId === 'image-a')!;
  assert.equal(failed.workflowSnapshot?.revision, firstPublished.workflow.revision);
  assert.equal(failed.nodes.find((node) => node.id === 'export')?.attempts, 0);
  assert.equal((await app.inject({ method: 'POST', url: `/api/runs/${created.id}/retry` })).statusCode, 200);
  const complete = await waitFor(app, created.id, (run) => run.status === 'succeeded');
  assert.equal(complete.assets.find((asset) => asset.nodeId === 'image-a')?.id, successfulBranch.id);
  assert.equal(complete.nodes.find((node) => node.id === 'export')?.attempts, 1);

  const changed = structuredClone(branchDefinition());
  const wide = changed.nodes.find((node) => node.id === 'image-b') as Extract<WorkflowDefinition['nodes'][number], { kind: 'image' }>;
  wide.config.width = 2048;
  const edit = await app.inject({ method: 'POST', url: `/api/workflows/${request.templateId}`, payload: { revision: firstPublished.revision, workflow: changed } });
  const editResult = edit.json<{ revision: number }>();
  const republished = await app.inject({ method: 'POST', url: `/api/workflows/${request.templateId}/publish`, payload: { revision: editResult.revision } });
  const newRevision = republished.json().workflow.revision;
  await app.inject({ method: 'POST', url: `/api/workflows/${request.templateId}/archive`, payload: { revision: republished.json().revision } });
  const replay = await app.inject({ method: 'POST', url: '/api/runs', payload: request });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json().run, complete);
  assert.equal(replay.json().run.workflowSnapshot.revision, firstPublished.workflow.revision);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs', payload: { ...request, idempotencyKey: 'archived-new-key' } })).statusCode, 409);
  assert.notEqual(newRevision, firstPublished.workflow.revision);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs', payload: { ...request, workflowRevision: newRevision } })).statusCode, 409);
});

test('workflow run recovery restarts from its immutable graph snapshot after a later publication', async (t) => {
  const { app, directory } = await fixture(t, { mockDelayMs: 100 });
  const published = await createAndPublish(app);
  const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { templateId: published.workflow.id, inputs: { prompt: 'Recovery snapshot', count: 2 }, idempotencyKey: 'workflow-recovery' } });
  const run = response.json<{ run: Run }>().run;
  await waitFor(app, run.id, (current) => current.nodes[0]?.status === 'running');
  const changed = structuredClone(branchDefinition());
  const image = changed.nodes.find((node) => node.id === 'image-a') as Extract<WorkflowDefinition['nodes'][number], { kind: 'image' }>;
  image.config.width = 2048;
  const edit = await app.inject({ method: 'POST', url: `/api/workflows/${run.templateId}`, payload: { revision: published.revision, workflow: changed } });
  const saved = edit.json<{ revision: number }>();
  assert.equal((await app.inject({ method: 'POST', url: `/api/workflows/${run.templateId}/publish`, payload: { revision: saved.revision } })).statusCode, 200);
  await app.close();

  const restarted = await import('../src/app.js').then(({ createApp: open }) => open({ dataDir: directory, mockDelayMs: 1 }));
  try {
    const complete = await waitFor(restarted, run.id, (current) => current.status === 'succeeded');
    assert.equal(complete.workflowSnapshot?.revision, published.workflow.revision);
    assert.deepEqual([complete.assets.find((asset) => asset.nodeId === 'image-a')?.width], [512]);
    assert.equal(complete.expectedAssetCount, 3);
  } finally { await restarted.close(); }
});

test('expanded prompt amplification is capped before any run or idempotency submission is persisted', async (t) => {
  const { app } = await fixture(t);
  const workflow: WorkflowDefinition = {
    name: 'Bounded prompt chain', description: 'Checks the expanded prompt ceiling.',
    nodes: [
      { id: 'p0', name: 'Root prompt', position: { x: 0, y: 0 }, kind: 'prompt', config: { template: '{{prompt}}{{prompt}}', roleRef: null } },
      { id: 'p1', name: 'Prompt two', position: { x: 150, y: 0 }, kind: 'prompt', config: { template: '{{prompt}}{{prompt}}', roleRef: null } },
      { id: 'p2', name: 'Prompt three', position: { x: 300, y: 0 }, kind: 'prompt', config: { template: '{{prompt}}{{prompt}}', roleRef: null } },
      { id: 'p3', name: 'Prompt four', position: { x: 450, y: 0 }, kind: 'prompt', config: { template: '{{prompt}}{{prompt}}', roleRef: null } },
      { id: 'image', name: 'Render', position: { x: 600, y: 0 }, kind: 'image', config: { width: 512, height: 512, count: 1 } },
      { id: 'export', name: 'Export', position: { x: 750, y: 0 }, kind: 'export', config: {} },
    ],
    edges: [
      { id: 'p0-p1', source: 'p0', target: 'p1' }, { id: 'p1-p2', source: 'p1', target: 'p2' }, { id: 'p2-p3', source: 'p2', target: 'p3' },
      { id: 'p3-image', source: 'p3', target: 'image' }, { id: 'image-export', source: 'image', target: 'export' },
    ],
  };
  const published = await createAndPublish(app, workflow);
  const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { templateId: published.workflow.id, inputs: { prompt: 'x'.repeat(2000), count: 1 }, idempotencyKey: 'prompt-amplification' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'PROMPT_TOO_LARGE');
  assert.equal((await app.inject('/api/runs')).json().runs.length, 0);
});

test('runs v1 migration preserves bytes, nodes, assets and idempotency behind a recoverable backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-runs-v1-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const now = '2026-10-07T00:00:00.000Z';
  const request = { templateId: 'brand-assets', inputs: { prompt: 'Legacy run', count: 1 } };
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const run: Run = {
    id: randomUUID(), templateId: 'brand-assets', status: 'succeeded', inputs: request.inputs, createdAt: now, updatedAt: now, mode: 'mock',
    nodes: [{ id: 'brief', name: 'Prepare brand brief', kind: 'prompt', status: 'succeeded', attempts: 1 }, { id: 'generate', name: 'Render mock concepts', kind: 'image', status: 'succeeded', attempts: 1 }, { id: 'export', name: 'Prepare downloadable assets', kind: 'export', status: 'succeeded', attempts: 1 }],
    assets: [], estimatedCost: 0, actualCost: 0,
  };
  const original = JSON.stringify({ version: 1, runs: [run], submissions: [{ key: 'legacy-idempotency', fingerprint, runId: run.id }] });
  await writeFile(join(directory, 'runs.json'), original, { mode: 0o600 });
  const app = await createApp({ dataDir: directory, mockDelayMs: 1 });
  try {
    assert.equal(await readFile(join(directory, 'runs.json.v1.bak'), 'utf8'), original);
    assert.equal(JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8')).version, 2);
    assert.deepEqual((await app.inject(`/api/runs/${run.id}`)).json().run, run);
    const replay = await app.inject({ method: 'POST', url: '/api/runs', payload: { ...request, idempotencyKey: 'legacy-idempotency' } });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json().run, run);
  } finally { await app.close(); }
  const restarted = await createApp({ dataDir: directory, mockDelayMs: 1 });
  try {
    assert.equal(await readFile(join(directory, 'runs.json.v1.bak'), 'utf8'), original);
    assert.deepEqual((await restarted.inject(`/api/runs/${run.id}`)).json().run, run);
    assert.equal((await restarted.inject({ method: 'POST', url: '/api/runs', payload: { ...request, idempotencyKey: 'legacy-idempotency' } })).statusCode, 200);
  } finally { await restarted.close(); }
});

test('workflow storage rejects malformed histories and OpenAPI covers the configuration endpoints', async (t) => {
  const { app, directory } = await fixture(t);
  const spec = (await app.inject('/api/openapi.json')).json();
  for (const path of ['/api/workflows', '/api/workflows/validate', '/api/workflows/{id}/publish', '/api/workflows/{id}/archive', '/api/workflows/{id}/revisions']) assert.ok(spec.paths[path]);
  assert.ok(spec.components.schemas.Workflow.properties.roleSnapshots);
  await app.close();
  const corrupt = '{"schemaVersion":99,"revision":0,"workflowHistory":[]}';
  await writeFile(join(directory, 'workflows.json'), corrupt);
  await assert.rejects(createApp({ dataDir: directory }), /Invalid|version|schema/i);
  assert.equal(await readFile(join(directory, 'workflows.json'), 'utf8'), corrupt);
});
