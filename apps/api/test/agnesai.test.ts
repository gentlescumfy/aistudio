import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgnesAi } from '../src/agnesai.js';
import { fixture } from './helpers.js';

test('AgnesAI validation reports a missing server key without making a request', async () => {
  let requests = 0;
  const result = await validateAgnesAi(async () => { requests += 1; return Response.json({ data: [] }); }, {});
  assert.equal(result.status, 'missing_key');
  assert.equal(result.ok, false);
  assert.equal(result.modelCount, null);
  assert.equal(requests, 0);
});

test('AgnesAI validation reads only the model catalogue and never returns model IDs or the key', async () => {
  const key = 'private-test-key';
  const result = await validateAgnesAi(async (input, init) => {
    assert.equal(String(input), 'https://apihub.agnes-ai.com/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    assert.equal(init?.redirect, 'error');
    return Response.json({ object: 'list', data: [{ id: 'text-model' }, { id: 'image-model' }] });
  }, { GNESAI_API_KEY: key });
  assert.equal(result.status, 'connected');
  assert.equal(result.ok, true);
  assert.equal(result.modelCount, 2);
  assert.equal(result.message.includes(key), false);
  assert.equal(result.message.includes('text-model'), false);
});

test('AgnesAI validation sanitizes rejected credentials and upstream errors', async () => {
  const rejected = await validateAgnesAi(async () => new Response('secret echoed by upstream', { status: 401 }), { GNESAI_API_KEY: 'private-test-key' });
  assert.equal(rejected.status, 'unauthorized');
  assert.equal(rejected.message.includes('secret echoed'), false);

  const failed = await validateAgnesAi(async () => { throw new Error('network error containing private-test-key'); }, { GNESAI_API_KEY: 'private-test-key' });
  assert.equal(failed.status, 'network_error');
  assert.equal(failed.message.includes('private-test-key'), false);
});

test('POST /api/settings/validate-agnesai returns the bounded catalogue result', async t => {
  const { app } = await fixture(t, {
    agnesAiFetch: async () => Response.json({ data: [{ id: 'text-model' }] }),
    agnesAiEnvironment: { GNESAI_API_KEY: 'private-test-key' },
  });
  const result = await app.inject({ method: 'POST', url: '/api/settings/validate-agnesai', payload: {} });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, 'connected');
  assert.equal(result.json().modelCount, 1);

  const invalid = await app.inject({ method: 'POST', url: '/api/settings/validate-agnesai', payload: { apiKey: 'must-not-be-accepted' } });
  assert.equal(invalid.statusCode, 400);
});
