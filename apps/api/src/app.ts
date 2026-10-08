import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, createSchema, findRun, templates } from './domain.js';
import { FileStore } from './store.js';
import { AssetStore } from './assets.js';
import { RunEngine } from './engine.js';
import { MockProvider, type Provider } from './provider.js';
import { openapi } from './openapi.js';
import { SettingsStore, saveSettingsSchema } from './settings.js';
import { RoleStore, archiveRoleRequestSchema, createRoleRequestSchema, editRoleRequestSchema } from './roles.js';
import { WorkflowStore } from './workflows.js';
import { LangflowService } from './langflow.js';
import { validateAgnesAi } from './agnesai.js';
import { langflowRunRequestSchema, saveLangflowConfigSchema } from './langflow-contract.js';
import { workflowArchiveRequestSchema, workflowDefinitionSchema, workflowMutationSchema, workflowPublishRequestSchema } from './workflow-contract.js';
import { TextAgentRuntime } from './agent-runtime.js';

export interface AppOptions {
  dataDir: string;
  origins?: string[];
  mockDelayMs?: number;
  logger?: boolean;
  /** Local tests only; no user-selected provider or node executor is accepted. */
  provider?: Provider;
  /** Tests inject a bounded fake upstream; production always uses Node's fetch. */
  langflowFetch?: typeof fetch;
  /** Tests may inject the provider-catalogue request; production uses Node's fetch. */
  agnesAiFetch?: typeof fetch;
  /** Tests may inject a non-persistent environment snapshot; production uses process.env. */
  agnesAiEnvironment?: NodeJS.ProcessEnv;
}
const idSchema = z.uuid();
const noBody = z.strictObject({});
export const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const origins = new Set(options.origins ?? defaultOrigins);
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('FRONTEND_ORIGINS must contain exact HTTP(S) origins.');
  }
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024,
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
    },
  });
  const store = await FileStore.open(options.dataDir);
  let engine: RunEngine | undefined;
  let roles: RoleStore | undefined;
  let workflows: WorkflowStore | undefined;
  let settingsStore: SettingsStore | undefined;
  let langflow: LangflowService | undefined;
  try {
    const assets = await AssetStore.open(options.dataDir);
    settingsStore = await SettingsStore.open(options.dataDir);
    const settings = settingsStore;
    const agnesAiFetch = options.agnesAiFetch ?? fetch;
    const agnesAiEnvironment = options.agnesAiEnvironment ?? process.env;
    roles = await RoleStore.open(options.dataDir);
    workflows = await WorkflowStore.open(options.dataDir);
    langflow = await LangflowService.open(options.dataDir, options.langflowFetch ?? fetch, (message) => app.log.error(message));
    engine = new RunEngine(
      store, assets, options.provider ?? new MockProvider(options.mockDelayMs),
      (error) => app.log.error({ err: error }, 'Executor stopped after storage failure'), workflows,
      (selection, deadlineMs) => settings.resolveTextAgentTarget(selection.kind === 'binding' ? selection.binding : undefined, deadlineMs),
      new TextAgentRuntime(fetch, process.env),
    );
    const runs = engine;
    const roleStore = roles;
    const workflowStore = workflows;
    const langflowService = langflow;
    const resolveRoleModel = (binding: import('./settings.js').ModelBinding) => settings.hasDeclaredTextModelBinding(binding);
    const resolveRoleRevision = (id: string, revision: number) => {
      try {
        const history = roleStore.revisions(id, resolveRoleModel);
        const role = history.find((entry) => entry.revision === revision);
        const currentLifecycle = history.at(-1)?.lifecycle;
        return role && currentLifecycle ? { role, currentLifecycle } : undefined;
      }
      catch { return undefined; }
    };
    app.addHook('onClose', async () => { await runs.stop(); await workflowStore.close(); await roleStore.close(); await settings.close(); await langflowService.close(); await store.close(); });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('x-request-id', request.id);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'no-store');
      // Reject hostile Host headers as well as binding the socket to loopback.
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(request.headers.host ?? '')) {
        throw new ApiError(403, 'HOST_FORBIDDEN', 'Only local development hosts are allowed.');
      }
      const origin = request.headers.origin;
      reply.header('vary', 'Origin');
      if (origin && !origins.has(origin)) throw new ApiError(403, 'ORIGIN_FORBIDDEN', 'Origin is not allowed.');
      if (origin) reply.header('access-control-allow-origin', origin);
      if (request.method === 'OPTIONS') {
        if (!['GET', 'POST'].includes(request.headers['access-control-request-method'] ?? '')) {
          throw new ApiError(403, 'CORS_METHOD_FORBIDDEN', 'Preflight method is not allowed.');
        }
        const requestedHeaders = (request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
        if (requestedHeaders.some((header) => !['content-type', 'x-request-id'].includes(header))) {
          throw new ApiError(403, 'CORS_HEADER_FORBIDDEN', 'Preflight header is not allowed.');
        }
        reply.header('access-control-allow-methods', 'GET, POST');
        reply.header('access-control-allow-headers', 'Content-Type, X-Request-Id');
        return reply.code(204).send();
      }
    });
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') } });
      const candidate = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
      const status = typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 500;
      if (status === 500) request.log.error({ err: error }, 'Request failed');
      return reply.code(status).send({ error: {
        code: status === 413 ? 'BODY_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR',
        message: status === 500 ? 'Internal server error. Check the local API logs.' : 'Invalid request body or content type.',
      } });
    });
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }));
    app.get('/api/health', async () => {
      runs.assertAvailable(); settings.assertAvailable(); roleStore.assertAvailable(); workflowStore.assertAvailable();
      const settingsRuntime = settings.read().runtime;
      return { status: 'ok', mode: settingsRuntime.mode, roleStorage: { available: true, mode: 'single-turn-text' }, workflowStorage: { available: true, mode: 'local-file' } };
    });
    app.get('/api/templates', async () => ({ templates: [...templates, ...workflowStore.templates()] }));
    app.get('/api/workflows', async () => workflowStore.read());
    app.post('/api/workflows', { bodyLimit: 128 * 1024 }, async (request, reply) => {
      const input = workflowMutationSchema.parse(request.body);
      return reply.code(201).send(await workflowStore.create(input.revision, input.workflow));
    });
    app.post('/api/workflows/validate', { bodyLimit: 128 * 1024 }, async (request) => {
      const input = z.strictObject({ workflow: workflowDefinitionSchema }).parse(request.body);
      return workflowStore.validate(input.workflow, resolveRoleRevision);
    });
    app.post<{ Params: { id: string } }>('/api/workflows/:id', { bodyLimit: 128 * 1024 }, async (request) => {
      const id = z.uuid().parse(request.params.id);
      const input = workflowMutationSchema.parse(request.body);
      return workflowStore.edit(id, input.revision, input.workflow);
    });
    app.post<{ Params: { id: string } }>('/api/workflows/:id/publish', { bodyLimit: 16 * 1024 }, async (request) => {
      const id = z.uuid().parse(request.params.id);
      const input = workflowPublishRequestSchema.parse(request.body);
      return workflowStore.publish(id, input.revision, resolveRoleRevision);
    });
    app.post<{ Params: { id: string } }>('/api/workflows/:id/archive', { bodyLimit: 16 * 1024 }, async (request) => {
      const id = z.uuid().parse(request.params.id);
      const input = workflowArchiveRequestSchema.parse(request.body);
      return workflowStore.archive(id, input.revision);
    });
    app.get<{ Params: { id: string } }>('/api/workflows/:id/revisions', async (request) => {
      const id = z.uuid().parse(request.params.id);
      return { revisions: workflowStore.revisions(id) };
    });
    app.get('/api/settings', async () => settings.read());
    app.post('/api/settings', { bodyLimit: 128 * 1024 }, async (request) => {
      runs.assertAvailable();
      return settings.save(saveSettingsSchema.parse(request.body));
    });
    app.post('/api/settings/validate-agnesai', async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      return validateAgnesAi(agnesAiFetch, agnesAiEnvironment);
    });
    app.get('/api/roles', async () => roleStore.read(resolveRoleModel));
    app.post('/api/roles', { bodyLimit: 64 * 1024 }, async (request, reply) => {
      const input = createRoleRequestSchema.parse(request.body);
      const result = await roleStore.create(input.revision, input.role, resolveRoleModel);
      return reply.code(201).send(result);
    });
    app.post<{ Params: { id: string } }>('/api/roles/:id', { bodyLimit: 64 * 1024 }, async (request) => {
      const id = z.union([z.uuid(), z.string().regex(/^[a-z0-9-]{1,64}$/)]).parse(request.params.id);
      const input = editRoleRequestSchema.parse(request.body);
      return roleStore.edit(id, input.revision, input.role, resolveRoleModel);
    });
    app.post<{ Params: { id: string } }>('/api/roles/:id/archive', async (request) => {
      const id = z.union([z.uuid(), z.string().regex(/^[a-z0-9-]{1,64}$/)]).parse(request.params.id);
      const input = archiveRoleRequestSchema.parse(request.body);
      return roleStore.archive(id, input.revision, resolveRoleModel);
    });
    app.get<{ Params: { id: string } }>('/api/roles/:id/revisions', async (request) => {
      const id = z.union([z.uuid(), z.string().regex(/^[a-z0-9-]{1,64}$/)]).parse(request.params.id);
      return { revisions: roleStore.revisions(id, resolveRoleModel) };
    });
    app.get('/api/langflow/config', async () => langflowService.readConfig());
    app.post('/api/langflow/config', { bodyLimit: 16 * 1024 }, async (request) => {
      const input = saveLangflowConfigSchema.parse(request.body);
      return langflowService.saveConfig(input.revision, input.config);
    });
    app.get('/api/langflow/status', async () => langflowService.status());
    app.get('/api/langflow/flows', async () => langflowService.flows());
    app.get('/api/langflow/runs', async () => langflowService.runs());
    app.get<{ Params: { id: string } }>('/api/langflow/runs/:id', async (request) => ({ run: langflowService.run(z.uuid().parse(request.params.id)) }));
    app.post('/api/langflow/runs', { bodyLimit: 16 * 1024 }, async (request, reply) => {
      const input = langflowRunRequestSchema.parse(request.body);
      const result = await langflowService.createRun(input);
      reply.header('location', `/api/langflow/runs/${result.run.id}`);
      return reply.code(result.replayed ? 200 : 202).send({ run: result.run });
    });
    app.get('/api/openapi.json', async () => openapi);
    app.get('/api/runs', async () => ({ runs: store.snapshot().runs.reverse() }));
    app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => ({ run: findRun(store.snapshot(), idSchema.parse(request.params.id)) }));
    app.post('/api/runs', async (request, reply) => {
      const input = createSchema.parse(request.body);
      const result = await runs.create(input.templateId, input.inputs, input.idempotencyKey, input.workflowRevision);
      reply.header('location', `/api/runs/${result.run.id}`);
      return reply.code(result.replayed ? 200 : 201).send({ run: result.run });
    });
    app.post<{ Params: { id: string } }>('/api/runs/:id/retry', async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      return { run: await runs.retry(idSchema.parse(request.params.id)) };
    });
    app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      return { run: await runs.cancel(idSchema.parse(request.params.id)) };
    });
    app.get<{ Params: { runId: string; assetId: string }; Querystring: { download?: string } }>('/api/assets/:runId/:assetId', async (request, reply) => {
      const runId = idSchema.parse(request.params.runId);
      const assetId = z.string().regex(/^[a-f0-9]{24}$/).parse(request.params.assetId);
      const query = z.strictObject({ download: z.enum(['0', '1']).optional() }).parse(request.query);
      const run = findRun(store.snapshot(), runId);
      const asset = run.assets.find((item) => item.id === assetId);
      if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
      const contents = await assets.read(asset);
      reply.header('content-security-policy', "default-src 'none'; style-src 'none'; sandbox");
      reply.header('content-disposition', `${query.download === '1' ? 'attachment' : 'inline'}; filename="${asset.name}"`);
      return reply.type(asset.mimeType).send(contents);
    });
    await runs.recover();
    return app;
  } catch (error) {
    await engine?.stop();
    await workflows?.close();
    await roles?.close();
    await settingsStore?.close();
    await langflow?.close();
    await store.close();
    throw error;
  }
}
