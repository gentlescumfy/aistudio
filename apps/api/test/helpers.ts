import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp, type AppOptions } from '../src/app.js';
import type { Run } from '../src/domain.js';

export async function fixture(t: TestContext, options: Partial<AppOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-api-test-'));
  const app = await createApp({ dataDir: directory, mockDelayMs: 2, ...options });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, directory };
}
export async function submit(app: FastifyInstance, key = 'test-key', prompt = 'Brand concept', count = 2): Promise<Run> {
  const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { templateId: 'brand-assets', inputs: { prompt, count }, idempotencyKey: key } });
  if (response.statusCode !== 201) throw new Error(response.body);
  return response.json<{ run: Run }>().run;
}
export async function getRun(app: FastifyInstance, id: string): Promise<Run> {
  return (await app.inject(`/api/runs/${id}`)).json<{ run: Run }>().run;
}
export async function waitFor(app: FastifyInstance, id: string, condition: (run: Run) => boolean): Promise<Run> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const run = await getRun(app, id);
    if (condition(run)) return run;
    await delay(5);
  }
  throw new Error(`Timed out waiting for run ${id}`);
}
