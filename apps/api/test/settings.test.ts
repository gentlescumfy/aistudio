import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { fixture } from './helpers.js';

const draft = {
  providers: [{ id: 'text-demo', name: 'Text draft', transport: 'api', protocol: 'openai-compatible', baseUrl: 'https://example.com/v1' }],
  accounts: [{ id: 'work-account', providerId: 'text-demo', label: 'Work', secretEnv: 'AISTUDIO_TEST_KEY', enabled: true }],
  models: [{ id: 'chat-model', accountId: 'work-account', externalId: 'vendor-chat-v2', name: 'Chat draft', capabilities: ['text', 'code'], pinned: true }],
};
const binding = { providerId: 'text-demo', accountId: 'work-account', modelId: 'chat-model' };
const validV2 = { schemaVersion: 2, revision: 0, settings: { defaultCount: 2, ...draft, routes: { text: binding, image: 'mock-svg', video: null } } };
const v1Provider = (id: string, fields: Record<string, unknown> = {}) => ({
  id, name: `  ${id} account  `, protocol: 'openai-compatible', baseUrl: `https://${id}.example.test/v1`, model: `${id}-external-model`, secretEnv: 'AISTUDIO_TEST_KEY', ...fields,
});
const legacy = {
  revision: 7,
  settings: { defaultCount: 3, providers: [v1Provider('text-draft'), v1Provider('video-draft'), v1Provider('unused-draft')],
    routes: { text: 'text-draft', image: 'mock-svg', video: 'video-draft' } },
};

test('GET always returns the full v2 contract; credential status is account-scoped and exposes presence only', async t => {
  const { app } = await fixture(t);
  const initial = await app.inject('/api/settings');
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), {
    schemaVersion: 2, revision: 0,
    settings: { defaultCount: 4, providers: [], accounts: [], models: [], routes: { text: null, image: 'mock-svg', video: null } },
    runtime: { mode: 'mock', activeImageModel: 'mock-svg', externalProvidersEnabled: false }, credentials: [],
  });
  const old = process.env.AISTUDIO_TEST_KEY;
  process.env.AISTUDIO_TEST_KEY = 'sensitive-test-value-that-must-never-be-returned';
  try {
    const saved = await app.inject({ method: 'POST', url: '/api/settings', payload: validV2 });
    assert.equal(saved.statusCode, 200, saved.body);
    const response = saved.json();
    assert.equal(response.schemaVersion, 2);
    assert.equal(response.settings.providers[0].id, 'text-demo');
    assert.deepEqual(response.credentials, [{ accountId: 'work-account', configured: true }]);
    assert.ok(!saved.body.includes('sensitive-test-value'));
    assert.ok(!saved.body.includes('providerId\":\"text-demo\",\"configured'));
    delete process.env.AISTUDIO_TEST_KEY;
    assert.deepEqual((await app.inject('/api/settings')).json().credentials, [{ accountId: 'work-account', configured: false }]);
  } finally {
    if (old === undefined) delete process.env.AISTUDIO_TEST_KEY;
    else process.env.AISTUDIO_TEST_KEY = old;
  }
});

test('v2 schema validates collection limits, links, endpoint transport, ownership, capabilities and exact fields', async t => {
  const { app } = await fixture(t);
  const invalid: unknown[] = [
    { ...validV2, settings: { ...validV2.settings, providers: [draft.providers[0], draft.providers[0]] } },
    { ...validV2, settings: { ...validV2.settings, accounts: [draft.accounts[0], draft.accounts[0]] } },
    { ...validV2, settings: { ...validV2.settings, models: [draft.models[0], draft.models[0]] } },
    { ...validV2, settings: { ...validV2.settings, accounts: [{ ...draft.accounts[0], providerId: 'missing' }] } },
    { ...validV2, settings: { ...validV2.settings, models: [{ ...draft.models[0], accountId: 'missing' }] } },
    { ...validV2, settings: { ...validV2.settings, models: [{ ...draft.models[0], externalId: 'vendor-chat-v2' }, { ...draft.models[0], id: 'another-model' }] } },
    { ...validV2, settings: { ...validV2.settings, models: [{ ...draft.models[0], capabilities: [] }] } },
    { ...validV2, settings: { ...validV2.settings, models: [{ ...draft.models[0], capabilities: ['text', 'text'] }] } },
    { ...validV2, settings: { ...validV2.settings, routes: { ...validV2.settings.routes, text: { ...binding, providerId: 'missing' } } } },
    { ...validV2, settings: { ...validV2.settings, accounts: [{ ...draft.accounts[0], enabled: false }] } },
    { ...validV2, settings: { ...validV2.settings, models: [{ ...draft.models[0], capabilities: ['image'] }] } },
    { ...validV2, settings: { ...validV2.settings, routes: { ...validV2.settings.routes, video: binding } } },
    { ...validV2, settings: { ...validV2.settings, routes: { ...validV2.settings.routes, image: binding } } },
    { ...validV2, settings: { ...validV2.settings, providers: [{ ...draft.providers[0], transport: 'local', baseUrl: 'https://example.com/v1' }] } },
    { ...validV2, settings: { ...validV2.settings, providers: [{ ...draft.providers[0], baseUrl: 'http://example.com/v1' }] } },
    { ...validV2, settings: { ...validV2.settings, providers: [{ ...draft.providers[0], baseUrl: 'http://localhost/v1?token=x' }] } },
    { ...validV2, settings: { ...validV2.settings, providers: [{ ...draft.providers[0], baseUrl: 'https://example.com/v1?' }] } },
    { ...validV2, settings: { ...validV2.settings, providers: [{ ...draft.providers[0], baseUrl: 'https://@example.com/v1' }] } },
    { ...validV2, settings: { ...validV2.settings, accounts: [{ ...draft.accounts[0], secretEnv: 'lowercase-name' }] } },
    { ...validV2, settings: { ...validV2.settings, providers: [{ ...draft.providers[0], apiKey: 'raw-key-must-be-rejected' }] } },
    { ...validV2, settings: { ...validV2.settings, extra: true } },
    { ...validV2, schemaVersion: 1 },
    { revision: 0, settings: validV2.settings },
    { ...validV2, settings: { ...validV2.settings, defaultCount: 9 } },
  ];
  for (const payload of invalid) {
    const result = await app.inject({ method: 'POST', url: '/api/settings', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    assert.equal(result.statusCode, 400, result.body);
  }
  const tooManyProviders = { ...validV2, settings: { ...validV2.settings, providers: Array.from({ length: 9 }, (_, i) => ({ ...draft.providers[0], id: `provider-${i}` })) } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/settings', payload: tooManyProviders })).statusCode, 400);
  const tooManyAccounts = { ...validV2, settings: { ...validV2.settings, accounts: Array.from({ length: 17 }, (_, i) => ({ ...draft.accounts[0], id: `account-${i}` })) } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/settings', payload: tooManyAccounts })).statusCode, 400);
  const tooManyModels = { ...validV2, settings: { ...validV2.settings, models: Array.from({ length: 65 }, (_, i) => ({ ...draft.models[0], id: `model-${i}`, externalId: `ext-${i}` })) } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/settings', payload: tooManyModels })).statusCode, 400);
  assert.equal((await app.inject('/api/settings')).json().revision, 0);
  const localAndCodeDraft = {
    ...validV2,
    settings: {
      ...validV2.settings,
      providers: [{ ...draft.providers[0], transport: 'local', baseUrl: 'http://127.0.0.1:11434/v1' }],
      models: [{ ...draft.models[0], capabilities: ['code', 'image'] }],
      routes: { text: binding, image: binding, video: null },
    },
  };
  const validLocal = await app.inject({ method: 'POST', url: '/api/settings', payload: localAndCodeDraft });
  assert.equal(validLocal.statusCode, 200, validLocal.body);
  assert.deepEqual(validLocal.json().settings.routes.image, binding);
  assert.equal(validLocal.json().runtime.activeImageModel, 'mock-svg');
});

test('legacy v1 file migrates in memory, preserves the original until save, then writes v2 atomically', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-settings-migration-'));
  const path = join(directory, 'settings.json');
  const original = JSON.stringify(legacy, null, 2);
  await writeFile(path, original);
  const app = await createApp({ dataDir: directory });
  t.after(async () => { await app.close(); });
  const response = await app.inject('/api/settings');
  assert.equal(response.statusCode, 200, response.body);
  const migrated = response.json();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.revision, legacy.revision);
  assert.equal(migrated.settings.defaultCount, 3);
  assert.equal(migrated.settings.providers.length, 3);
  assert.equal(migrated.settings.accounts.length, 3);
  assert.equal(migrated.settings.models.length, 3);
  assert.equal(migrated.settings.providers[0].id, 'text-draft');
  assert.equal(migrated.settings.providers[0].name, 'text-draft account');
  assert.equal(migrated.settings.providers[0].baseUrl, 'https://text-draft.example.test/v1');
  assert.equal(migrated.settings.providers[0].protocol, 'openai-compatible');
  assert.equal(migrated.settings.accounts[0].label, 'text-draft account');
  assert.equal(migrated.settings.accounts[0].secretEnv, 'AISTUDIO_TEST_KEY');
  assert.equal(migrated.settings.models[0].externalId, 'text-draft-external-model');
  assert.equal(migrated.settings.models[0].name, 'text-draft-external-model');
  assert.deepEqual(migrated.settings.models[0].capabilities, ['text', 'code']);
  assert.deepEqual(migrated.settings.models[1].capabilities, ['video']);
  assert.deepEqual(migrated.settings.models[2].capabilities, ['text']);
  assert.deepEqual(migrated.settings.routes.text, { providerId: 'text-draft', accountId: migrated.settings.accounts[0].id, modelId: migrated.settings.models[0].id });
  assert.equal(migrated.settings.routes.video.providerId, 'video-draft');
  assert.equal(migrated.settings.routes.image, 'mock-svg');
  for (const collection of [migrated.settings.accounts, migrated.settings.models]) {
    assert.equal(new Set(collection.map((item: { id: string }) => item.id)).size, collection.length);
    for (const item of collection) assert.ok(item.id.length <= 64 && /^[a-z0-9-]+$/.test(item.id));
  }
  assert.equal(await readFile(path, 'utf8'), original, 'GET migration must leave original legacy bytes untouched');
  assert.deepEqual((await app.inject('/api/settings')).json(), migrated);
  assert.equal(await readFile(path, 'utf8'), original);

  const saved = await app.inject({ method: 'POST', url: '/api/settings', payload: { schemaVersion: 2, revision: migrated.revision, settings: migrated.settings } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().revision, 8);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.revision, 8);
  assert.deepEqual(stored.settings, migrated.settings);
});

test('compatibility POST accepts v1 and always persists/returns v2', async t => {
  const { app, directory } = await fixture(t);
  const body = { revision: 0, settings: { defaultCount: 5, providers: [v1Provider('legacy-one')], routes: { text: 'legacy-one', image: 'mock-svg', video: null } } };
  const result = await app.inject({ method: 'POST', url: '/api/settings', payload: body });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().schemaVersion, 2);
  assert.equal(result.json().revision, 1);
  assert.equal(result.json().settings.providers[0].id, 'legacy-one');
  assert.equal(result.json().settings.models[0].externalId, 'legacy-one-external-model');
  assert.deepEqual(result.json().settings.models[0].capabilities, ['text', 'code']);
  const stored = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.revision, 1);
});

test('legacy migration IDs are deterministic across restarts; stale revision and concurrent v2 saves conflict', async t => {
  const { app, directory } = await fixture(t);
  const firstResponse = await app.inject({ method: 'POST', url: '/api/settings', payload: { ...legacy, revision: 0 } });
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  const first = firstResponse.json();
  assert.equal(first.revision, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/settings', payload: { ...legacy, revision: 0 } })).statusCode, 409);
  await app.close();
  const restarted = await createApp({ dataDir: directory });
  try {
    const current = (await restarted.inject('/api/settings')).json();
    assert.deepEqual(current.settings.accounts.map((item: { id: string }) => item.id), first.settings.accounts.map((item: { id: string }) => item.id));
    assert.deepEqual(current.settings.models.map((item: { id: string }) => item.id), first.settings.models.map((item: { id: string }) => item.id));
    const responses = await Promise.all([2, 6].map((defaultCount) => restarted.inject({ method: 'POST', url: '/api/settings', payload: { schemaVersion: 2, revision: current.revision, settings: { ...current.settings, defaultCount } } })));
    assert.deepEqual(responses.map((item) => item.statusCode).sort(), [200, 409]);
    assert.equal((await restarted.inject('/api/settings')).json().schemaVersion, 2);
  } finally { await restarted.close(); }
});

test('malformed and unsupported stored versions are rejected without changing original bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-settings-invalid-'));
  const path = join(directory, 'settings.json');
  for (const snapshot of [
    { schemaVersion: 3, revision: 4, settings: {} },
    { schemaVersion: 2, revision: 4, settings: {} },
    { revision: 4, settings: { ...legacy.settings, rawKey: 'never' } },
    '{invalid json',
  ]) {
    const bytes = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
    await writeFile(path, bytes);
    await assert.rejects(createApp({ dataDir: directory }));
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
});

test('settings POST has 128 KiB body limit while persisting a larger valid v2 draft', async t => {
  const { app } = await fixture(t);
  const providers = Array.from({ length: 8 }, (_, index) => ({ ...draft.providers[0], id: `provider-${index}`, baseUrl: `https://example.com/${'p'.repeat(900)}${index}` }));
  const accounts = Array.from({ length: 16 }, (_, index) => ({ ...draft.accounts[0], id: `account-${index}`, providerId: providers[Math.floor(index / 2)]!.id }));
  const models = Array.from({ length: 64 }, (_, index) => ({ ...draft.models[0], id: `model-${index}`, accountId: accounts[Math.floor(index / 4)]!.id, externalId: `external-${index}-${'m'.repeat(145)}`, name: `Model ${'n'.repeat(70)} ${index}`, capabilities: ['text'] }));
  const payload = { schemaVersion: 2, revision: 0, settings: { defaultCount: 1, providers, accounts, models, routes: { text: null, image: 'mock-svg', video: null } } };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 16 * 1024);
  const result = await app.inject({ method: 'POST', url: '/api/settings', payload });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().settings.models.length, 64);
});

test('OpenAPI declares v2 schema, account credential states and legacy POST body without transform schemas', async t => {
  const { app } = await fixture(t);
  const spec = (await app.inject('/api/openapi.json')).json();
  const schemas = spec.components.schemas;
  assert.equal(schemas.SettingsResponse.properties.schemaVersion.const, 2);
  assert.ok(schemas.Settings.properties.providers && schemas.Settings.properties.accounts && schemas.Settings.properties.models);
  assert.ok(schemas.SettingsResponse.properties.credentials.items.properties.accountId);
  assert.equal(schemas.SettingsResponse.properties.credentials.items.properties.providerId, undefined);
  assert.equal(schemas.SaveSettings.oneOf.length, 2);
  assert.equal(schemas.SaveSettings.oneOf[0].properties.schemaVersion.const, 2);
  assert.ok(schemas.LegacySettings.properties.settings.properties.providers.items.properties.model);
});

test('settings write fault fails closed and does not alter the original invalid target', async t => {
  const { app, directory } = await fixture(t);
  const path = join(directory, 'settings.json');
  await (await import('node:fs/promises')).mkdir(path);
  const result = await app.inject({ method: 'POST', url: '/api/settings', payload: validV2 });
  assert.equal(result.statusCode, 500);
  assert.equal((await app.inject('/api/settings')).statusCode, 503);
  assert.equal((await app.inject('/api/health')).statusCode, 503);
});
