import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { fixture } from './helpers.js';

const draft = {
  name: 'Context analyst', category: 'custom', description: 'Summarizes approved context for a project.',
  systemPrompt: 'Use only supplied material. Return a concise summary with cited source labels. Do not claim to execute tools or models.',
  inputContract: 'A question and approved project context references.',
  outputContract: 'A concise summary, key evidence and explicit uncertainty.',
  tools: ['context.search'], modelSelection: { kind: 'inherit' },
  limits: { maxSteps: 10, maxToolCalls: 8, deadlineMs: 60_000, maxCost: 0 },
};
const settingsDraft = {
  defaultCount: 2,
  providers: [{ id: 'local-text', name: 'Local text', transport: 'local', protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }],
  accounts: [{ id: 'account-primary', providerId: 'local-text', label: 'Primary', secretEnv: '', enabled: true }],
  models: [{ id: 'model-chat', accountId: 'account-primary', externalId: 'local-chat', name: 'Local chat', capabilities: ['code'], pinned: false }],
  routes: { text: { providerId: 'local-text', accountId: 'account-primary', modelId: 'model-chat' }, image: 'mock-svg', video: null },
};

async function createRole(app: Awaited<ReturnType<typeof fixture>>['app'], revision: number, role = draft) {
  return app.inject({ method: 'POST', url: '/api/roles', payload: { revision, role } });
}
async function saveSettings(app: Awaited<ReturnType<typeof fixture>>['app'], revision: number, settings: unknown) {
  return app.inject({ method: 'POST', url: '/api/settings', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ schemaVersion: 2, revision, settings }) });
}

test('role library seeds seven immutable built-ins and an explicitly non-executable tool catalogue', async t => {
  const { app } = await fixture(t);
  const library = (await app.inject('/api/roles')).json();
  assert.equal(library.revision, 0);
  assert.deepEqual(library.roles.map((role: { id: string }) => role.id), [
    'scriptwriter', 'storyboard-director', 'continuity-reviewer', 'editor', 'architect', 'developer', 'code-reviewer',
  ]);
  assert.ok(library.roles.every((role: { builtIn: boolean; revision: number; lifecycle: string; modelStatus: string }) => role.builtIn && role.revision === 1 && role.lifecycle === 'published' && role.modelStatus === 'inherit'));
  assert.equal(library.runtime.enabled, true);
  assert.equal(library.runtime.mode, 'single-turn-text');
  assert.deepEqual(library.tools.map((tool: { id: string }) => tool.id), [
    'assets.read', 'context.search', 'images.generate', 'media.render', 'code.read', 'code.edit', 'code.test',
  ]);
  assert.ok(library.tools.every((tool: { executable: boolean }) => tool.executable === false));
  assert.equal((await app.inject('/api/health')).json().roleStorage.available, true);
  for (const id of library.roles.map((role: { id: string }) => role.id)) {
    const revisions = (await app.inject(`/api/roles/${id}/revisions`)).json().revisions;
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].revision, 1);
  }
});

test('create, edit and archive append immutable snapshots with optimistic library revisions', async t => {
  const { app, directory } = await fixture(t);
  const simultaneous = await Promise.all([createRole(app, 0), createRole(app, 0)]);
  assert.deepEqual(simultaneous.map((response) => response.statusCode).sort(), [201, 409]);
  const first = simultaneous.find((response) => response.statusCode === 201)!;
  assert.equal(first.statusCode, 201, first.body);
  const created = first.json();
  assert.equal(created.revision, 1);
  assert.match(created.role.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.role.revision, 1);
  assert.equal(created.role.builtIn, false);
  assert.equal(created.role.lifecycle, 'draft');
  assert.equal(created.role.modelStatus, 'inherit');
  const original = structuredClone(created.role);
  assert.equal((await createRole(app, 0)).statusCode, 409);

  const edited = await app.inject({ method: 'POST', url: `/api/roles/${created.role.id}`, payload: { revision: 1, role: { ...draft, name: 'Context analyst v2', description: 'Edited draft.' } } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().revision, 2);
  assert.equal(edited.json().role.revision, 2);
  const history = (await app.inject(`/api/roles/${created.role.id}/revisions`)).json().revisions;
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], original);
  assert.equal(history[1].name, 'Context analyst v2');
  assert.equal((await app.inject({ method: 'POST', url: `/api/roles/${created.role.id}`, payload: { revision: 1, role: draft } })).statusCode, 409);

  const archived = await app.inject({ method: 'POST', url: `/api/roles/${created.role.id}/archive`, payload: { revision: 2 } });
  assert.equal(archived.statusCode, 200, archived.body);
  assert.equal(archived.json().revision, 3);
  assert.equal(archived.json().role.revision, 3);
  assert.equal(archived.json().role.lifecycle, 'archived');
  const repeated = await app.inject({ method: 'POST', url: `/api/roles/${created.role.id}/archive`, payload: { revision: 3 } });
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().revision, 3);
  assert.equal((await app.inject({ method: 'POST', url: `/api/roles/${created.role.id}`, payload: { revision: 3, role: draft } })).statusCode, 409);
  const final = (await app.inject('/api/roles')).json();
  assert.ok(final.roles.some((role: { id: string; lifecycle: string }) => role.id === created.role.id && role.lifecycle === 'archived'));
  assert.equal(final.revision, 3);

  const stored = JSON.parse(await readFile(join(directory, 'roles.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.revision, 3);
  assert.equal(stored.roleHistory.length, 10);
  const persistedOriginal = { ...original };
  delete persistedOriginal.modelStatus;
  assert.deepEqual(stored.roleHistory.find((role: { id: string; revision: number }) => role.id === created.role.id && role.revision === 1), persistedOriginal);
  await app.close();
  const restarted = await createApp({ dataDir: directory });
  try {
    const recovered = (await restarted.inject(`/api/roles/${created.role.id}/revisions`)).json().revisions;
    assert.deepEqual(recovered, history.concat({ ...archived.json().role }));
    assert.equal((await restarted.inject('/api/roles')).json().revision, 3);
  } finally { await restarted.close(); }
});

test('built-ins cannot be changed; unknown IDs, stale revisions and unknown fields use stable errors', async t => {
  const { app } = await fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/roles/scriptwriter', payload: { revision: 0, role: draft } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/roles/scriptwriter/archive', payload: { revision: 0 } })).statusCode, 409);
  assert.equal((await app.inject('/api/roles/no-such-role/revisions')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/roles', payload: { revision: 0, role: { ...draft, shell: 'enabled' } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/roles', payload: { revision: 0, role: { ...draft, tools: ['shell.exec'] } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/roles', payload: { revision: 0, role: { ...draft, tools: ['code.edit', 'code.edit'] } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/roles', payload: { revision: 0, role: { ...draft, limits: { ...draft.limits, maxSteps: 101 } } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/roles', payload: { revision: 0, role: { ...draft, systemPrompt: ' ' } } })).statusCode, 400);
});

test('explicit bindings require a complete enabled Settings v2 provider/account/model chain and declared text or code', async t => {
  const { app } = await fixture(t);
  assert.equal((await saveSettings(app, 0, settingsDraft)).statusCode, 200);
  const bindingSelection = { kind: 'binding', binding: { providerId: 'local-text', accountId: 'account-primary', modelId: 'model-chat' } };
  const boundDraft = { ...draft, modelSelection: bindingSelection };
  const created = await createRole(app, 0, boundDraft);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().role.modelStatus, 'configured');
  for (const modelSelection of [
    { kind: 'binding', binding: { providerId: 'other-provider', accountId: 'account-primary', modelId: 'model-chat' } },
    { kind: 'binding', binding: { providerId: 'local-text', accountId: 'missing-account', modelId: 'model-chat' } },
    { kind: 'binding', binding: { providerId: 'local-text', accountId: 'account-primary', modelId: 'missing-model' } },
    { kind: 'something-else' },
  ]) {
    const invalid = await createRole(app, 1, { ...draft, modelSelection });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  const disabled = { ...settingsDraft, accounts: [{ ...settingsDraft.accounts[0], enabled: false }], routes: { ...settingsDraft.routes, text: null } };
  assert.equal((await saveSettings(app, 1, disabled)).statusCode, 200);
  const library = (await app.inject('/api/roles')).json();
  const role = library.roles.find((item: { id: string }) => item.id === created.json().role.id);
  assert.deepEqual(role.modelSelection, bindingSelection);
  assert.equal(role.modelStatus, 'unavailable');
  const revisions = (await app.inject(`/api/roles/${role.id}/revisions`)).json().revisions;
  assert.equal(revisions[0].modelStatus, 'unavailable');
  const emptySettings = { defaultCount: 4, providers: [], accounts: [], models: [], routes: { text: null, image: 'mock-svg', video: null } };
  assert.equal((await saveSettings(app, 2, emptySettings)).statusCode, 200);
  assert.equal((await app.inject('/api/roles')).json().roles.find((item: { id: string }) => item.id === role.id).modelStatus, 'unavailable');
});

test('role revisions persist across restart, count cap and route body size are enforced', async t => {
  const { app, directory } = await fixture(t);
  for (let index = 0; index < 64; index++) {
    const created = await createRole(app, index, { ...draft, name: `Custom role ${index}` });
    assert.equal(created.statusCode, 201, created.body);
  }
  const overflow = await createRole(app, 64);
  assert.equal(overflow.statusCode, 409);
  assert.equal(overflow.json().error.code, 'ROLE_LIMIT_REACHED');
  const tooLarge = { revision: 64, role: { ...draft, extra: 'x'.repeat(20_000) } };
  const oversized = await app.inject({ method: 'POST', url: '/api/roles', payload: tooLarge });
  assert.notEqual(oversized.statusCode, 413, oversized.body);
  assert.equal(oversized.statusCode, 400);
  await app.close();
  const restarted = await createApp({ dataDir: directory });
  try {
    const library = (await restarted.inject('/api/roles')).json();
    assert.equal(library.roles.length, 71);
    assert.equal(library.revision, 64);
    assert.equal((await restarted.inject('/api/roles')).statusCode, 200);
  } finally { await restarted.close(); }
});

test('corrupt role history fails startup without overwriting it; a write fault marks health unavailable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-roles-corrupt-'));
  const path = join(directory, 'roles.json');
  for (const invalid of [
    '{broken', JSON.stringify({ schemaVersion: 2, revision: 0, roleHistory: [] }),
    JSON.stringify({ schemaVersion: 1, revision: 0, roleHistory: [] }),
  ]) {
    await writeFile(path, invalid);
    await assert.rejects(createApp({ dataDir: directory }));
    assert.equal(await readFile(path, 'utf8'), invalid);
  }
  const { app, directory: fresh } = await fixture(t);
  const target = join(fresh, 'roles.json');
  await (await import('node:fs/promises')).mkdir(target);
  const failed = await createRole(app, 0);
  assert.equal(failed.statusCode, 500);
  assert.equal((await app.inject('/api/roles')).statusCode, 503);
  assert.equal((await app.inject('/api/health')).statusCode, 503);
});

test('OpenAPI documents single-turn text roles, CRUD/revisions and non-executable allowlisted tools', async t => {
  const { app } = await fixture(t);
  const spec = (await app.inject('/api/openapi.json')).json();
  assert.ok(spec.paths['/api/roles'].get && spec.paths['/api/roles'].post);
  assert.ok(spec.paths['/api/roles/{id}'].post);
  assert.ok(spec.paths['/api/roles/{id}/archive'].post);
  assert.ok(spec.paths['/api/roles/{id}/revisions'].get);
  assert.equal(spec.components.schemas.RoleLibrary.properties.runtime.properties.enabled.const, true);
  assert.equal(spec.components.schemas.ToolDeclaration.properties.executable.const, false);
  assert.equal(spec.components.schemas.ToolDeclaration.properties.id.enum.length, 7);
});
