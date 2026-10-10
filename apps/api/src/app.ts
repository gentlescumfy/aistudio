import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, createSchema, findRun, templates } from './domain.js';
import { openapi } from './openapi.js';
import { saveSettingsSchema, type ModelBinding } from './settings.js';
import { archiveRoleRequestSchema, createRoleRequestSchema, editRoleRequestSchema } from './roles.js';
import { validateAgnesAi } from './agnesai.js';
import { langflowRunRequestSchema, saveLangflowConfigSchema } from './langflow-contract.js';
import { workflowArchiveRequestSchema, workflowDefinitionSchema, workflowMutationSchema, workflowPublishRequestSchema } from './workflow-contract.js';
import { compileWorkflowToLangflow } from './langflow-compiler.js';
import { type Provider } from './provider.js';
import { StorePool, type StoreSet } from './store-pool.js';
import { ProjectRegistry, assertProjectId } from './projects.js';
import { mcpGatewayPlugin } from './mcp.js';

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
const defaultProjectId = 'default';

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
  // Projects share one API process; each owns an isolated directory, so the existing
  // per-directory writer lock isolates them without changing the lock implementation.
  const pool = new StorePool({
    dataDir: options.dataDir,
    provider: options.provider,
    mockDelayMs: options.mockDelayMs,
    langflowFetch: options.langflowFetch,
    logError: (err, message) => app.log.error({ err }, message),
  });
  const agnesAiFetch = options.agnesAiFetch ?? fetch;
  const agnesAiEnvironment = options.agnesAiEnvironment ?? process.env;
  const projectOf = (request: FastifyRequest): StoreSet => (request as unknown as { project: StoreSet }).project;
  const resolveProjectId = (request: FastifyRequest): string => {
    const raw = request.headers['x-project-id'];
    const id = (typeof raw === 'string' && raw.trim().length > 0) ? raw.trim() : defaultProjectId;
    return assertProjectId(id);
  };
  const modelResolver = (set: StoreSet) => (binding: ModelBinding): boolean => set.settings.hasDeclaredTextModelBinding(binding);
  const revisionResolver = (set: StoreSet) => {
    const model = modelResolver(set);
    return (id: string, revision: number) => {
      try {
        const history = set.roles.revisions(id, model);
        const role = history.find((entry) => entry.revision === revision);
        const currentLifecycle = history.at(-1)?.lifecycle;
        return role && currentLifecycle ? { role, currentLifecycle } : undefined;
      }
      catch { return undefined; }
    };
  };
  try {
    const registry = await ProjectRegistry.open(options.dataDir);
    app.addHook('onClose', async () => { await pool.close(); });
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
        if (requestedHeaders.some((header) => !['content-type', 'x-request-id', 'x-project-id'].includes(header))) {
          throw new ApiError(403, 'CORS_HEADER_FORBIDDEN', 'Preflight header is not allowed.');
        }
        reply.header('access-control-allow-methods', 'GET, POST');
        reply.header('access-control-allow-headers', 'Content-Type, X-Request-Id, X-Project-Id');
        return reply.code(204).send();
      }
      // Every project-scoped request routes to that project's isolated store set.
      (request as unknown as { project: StoreSet }).project = await pool.get(resolveProjectId(request));
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

    await app.register(mcpGatewayPlugin);

    // Project lifecycle (cross-project registry; not scoped to a single project).
    app.get('/api/projects', async () => ({ revision: registry.revision(), projects: registry.list() }));
    app.post('/api/projects', async (request, reply) => {
      const input = z.strictObject({ name: z.string().trim().min(1).max(80), id: z.string().trim().min(1).max(64).optional(), revision: z.number().int().nonnegative().optional() }).parse(request.body);
      const record = await registry.create({ name: input.name, id: input.id }, input.revision ?? registry.revision());
      await pool.get(record.id); // Initialise this project's isolated stores.
      reply.header('location', `/api/projects/${record.id}`);
      return reply.code(201).send({ record });
    });
    app.post<{ Params: { id: string } }>('/api/projects/:id/sync-langflow', async (request) => {
      const id = assertProjectId(request.params.id);
      const set = await pool.get(id);
      const name = registry.get(id)?.name ?? id;
      const result = await set.langflow.createProject(name);
      if (result) await registry.markLangflowSynced(id, result.langflowProjectId, registry.revision());
      return { projectId: id, langflowProjectId: result?.langflowProjectId ?? null, syncStatus: result ? 'synced' : 'pending' };
    });
    app.post<{ Params: { id: string } }>('/api/projects/:id/delete', async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      const id = assertProjectId(request.params.id);
      const removed = await registry.remove(id, registry.revision());
      await pool.evict(id);
      return { removed };
    });

    app.get('/api/health', async (request) => {
      const p = projectOf(request);
      p.engine.assertAvailable(); p.settings.assertAvailable(); p.roles.assertAvailable(); p.workflows.assertAvailable();
      const settingsRuntime = p.settings.read().runtime;
      return { status: 'ok', mode: settingsRuntime.mode, projectId: p.projectId, roleStorage: { available: true, mode: 'single-turn-text' }, workflowStorage: { available: true, mode: 'local-file' } };
    });
    app.get('/api/templates', async (request) => ({ templates: [...templates, ...projectOf(request).workflows.templates()] }));
    app.get('/api/workflows', async (request) => projectOf(request).workflows.read());
    app.post('/api/workflows', { bodyLimit: 128 * 1024 }, async (request, reply) => {
      const input = workflowMutationSchema.parse(request.body);
      return reply.code(201).send(await projectOf(request).workflows.create(input.revision, input.workflow));
    });
    app.post('/api/workflows/validate', { bodyLimit: 128 * 1024 }, async (request) => {
      const input = z.strictObject({ workflow: workflowDefinitionSchema }).parse(request.body);
      const p = projectOf(request);
      return p.workflows.validate(input.workflow, revisionResolver(p));
    });
    app.post<{ Params: { id: string } }>('/api/workflows/:id', { bodyLimit: 128 * 1024 }, async (request) => {
      const p = projectOf(request);
      const id = z.uuid().parse(request.params.id);
      const input = workflowMutationSchema.parse(request.body);
      return p.workflows.edit(id, input.revision, input.workflow);
    });
    app.post<{ Params: { id: string } }>('/api/workflows/:id/publish', { bodyLimit: 16 * 1024 }, async (request) => {
      const p = projectOf(request);
      const id = z.uuid().parse(request.params.id);
      const input = workflowPublishRequestSchema.parse(request.body);
      return p.workflows.publish(id, input.revision, revisionResolver(p));
    });
    app.post<{ Params: { id: string } }>('/api/workflows/:id/archive', { bodyLimit: 16 * 1024 }, async (request) => {
      const id = z.uuid().parse(request.params.id);
      const input = workflowArchiveRequestSchema.parse(request.body);
      return projectOf(request).workflows.archive(id, input.revision);
    });
    app.get<{ Params: { id: string } }>('/api/workflows/:id/revisions', async (request) => {
      const id = z.uuid().parse(request.params.id);
      return { revisions: projectOf(request).workflows.revisions(id) };
    });
    app.post('/api/workflows/compile-langflow', { bodyLimit: 128 * 1024 }, async (request) => {
      const input = z.strictObject({ workflow: workflowDefinitionSchema }).parse(request.body);
      const p = projectOf(request);
      const langflowProjectId = registry.get(p.projectId)?.langflowProjectId ?? null;
      const flow = compileWorkflowToLangflow(input.workflow, { projectId: langflowProjectId ?? undefined });
      return { flow };
    });
    app.post<{ Params: { id: string } }>('/api/workflows/:id/publish-langflow', { bodyLimit: 16 * 1024 }, async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      const p = projectOf(request);
      const id = z.uuid().parse(request.params.id);
      const workflowRecord = p.workflows.read().workflows.find((w) => w.id === id);
      if (!workflowRecord) {
        throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      }
      const langflowProjectId = registry.get(p.projectId)?.langflowProjectId ?? null;
      const result = await p.langflow.publishWorkflowToProject(langflowProjectId, workflowRecord);
      return { flowId: result.flowId, workflowId: id, projectId: p.projectId };
    });
    app.get('/api/settings', async (request) => projectOf(request).settings.read());
    app.post('/api/settings', { bodyLimit: 128 * 1024 }, async (request) => {
      const p = projectOf(request);
      p.engine.assertAvailable();
      return p.settings.save(saveSettingsSchema.parse(request.body));
    });
    app.post('/api/settings/validate-agnesai', async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      return validateAgnesAi(agnesAiFetch, agnesAiEnvironment);
    });
    app.get('/api/roles', async (request) => { const p = projectOf(request); return p.roles.read(modelResolver(p)); });
    app.post('/api/roles', { bodyLimit: 64 * 1024 }, async (request, reply) => {
      const p = projectOf(request);
      const input = createRoleRequestSchema.parse(request.body);
      const result = await p.roles.create(input.revision, input.role, modelResolver(p));
      return reply.code(201).send(result);
    });
    app.post<{ Params: { id: string } }>('/api/roles/:id', { bodyLimit: 64 * 1024 }, async (request) => {
      const p = projectOf(request);
      const id = z.union([z.uuid(), z.string().regex(/^[a-z0-9-]{1,64}$/)]).parse(request.params.id);
      const input = editRoleRequestSchema.parse(request.body);
      return p.roles.edit(id, input.revision, input.role, modelResolver(p));
    });
    app.post<{ Params: { id: string } }>('/api/roles/:id/archive', async (request) => {
      const p = projectOf(request);
      const id = z.union([z.uuid(), z.string().regex(/^[a-z0-9-]{1,64}$/)]).parse(request.params.id);
      const input = archiveRoleRequestSchema.parse(request.body);
      return p.roles.archive(id, input.revision, modelResolver(p));
    });
    app.get<{ Params: { id: string } }>('/api/roles/:id/revisions', async (request) => {
      const p = projectOf(request);
      const id = z.union([z.uuid(), z.string().regex(/^[a-z0-9-]{1,64}$/)]).parse(request.params.id);
      return { revisions: p.roles.revisions(id, modelResolver(p)) };
    });
    app.get('/api/langflow/config', async (request) => projectOf(request).langflow.readConfig());
    app.post('/api/langflow/config', { bodyLimit: 16 * 1024 }, async (request) => {
      const input = saveLangflowConfigSchema.parse(request.body);
      return projectOf(request).langflow.saveConfig(input.revision, input.config);
    });
    app.get('/api/langflow/status', async (request) => projectOf(request).langflow.status());
    app.get('/api/langflow/flows', async (request) => projectOf(request).langflow.flows());
    app.get('/api/langflow/runs', async (request) => projectOf(request).langflow.runs());
    app.get<{ Params: { id: string } }>('/api/langflow/runs/:id', async (request) => ({ run: projectOf(request).langflow.run(z.uuid().parse(request.params.id)) }));
    app.post('/api/langflow/runs', { bodyLimit: 16 * 1024 }, async (request, reply) => {
      const p = projectOf(request);
      const input = langflowRunRequestSchema.parse(request.body);
      const result = await p.langflow.createRun(input);
      reply.header('location', `/api/langflow/runs/${result.run.id}`);
      return reply.code(result.replayed ? 200 : 202).send({ run: result.run });
    });
    app.post<{ Params: { id: string } }>('/api/langflow/runs/:id/cancel', async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      return { run: await projectOf(request).langflow.cancel(z.uuid().parse(request.params.id)) };
    });
    app.get('/api/openapi.json', async () => openapi);
    app.get('/api/runs', async (request) => ({ runs: projectOf(request).file.snapshot().runs.reverse() }));
    app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => ({ run: findRun(projectOf(request).file.snapshot(), idSchema.parse(request.params.id)) }));
    app.post('/api/runs', async (request, reply) => {
      const p = projectOf(request);
      const input = createSchema.parse(request.body);
      const result = await p.engine.create(input.templateId, input.inputs, input.idempotencyKey, input.workflowRevision);
      reply.header('location', `/api/runs/${result.run.id}`);
      return reply.code(result.replayed ? 200 : 201).send({ run: result.run });
    });
    app.post<{ Params: { id: string } }>('/api/runs/:id/retry', async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      return { run: await projectOf(request).engine.retry(idSchema.parse(request.params.id)) };
    });
    app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request) => {
      noBody.parse(request.body === undefined ? {} : request.body);
      return { run: await projectOf(request).engine.cancel(idSchema.parse(request.params.id)) };
    });
    app.get<{ Params: { runId: string; assetId: string }; Querystring: { download?: string } }>('/api/assets/:runId/:assetId', async (request, reply) => {
      const p = projectOf(request);
      const runId = idSchema.parse(request.params.runId);
      const assetId = z.string().regex(/^[a-f0-9]{24}$/).parse(request.params.assetId);
      const query = z.strictObject({ download: z.enum(['0', '1']).optional() }).parse(request.query);
      const run = findRun(p.file.snapshot(), runId);
      const asset = run.assets.find((item) => item.id === assetId);
      if (!asset) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
      const contents = await p.assets.read(asset);
      reply.header('content-security-policy', "default-src 'none'; style-src 'none'; sandbox");
      reply.header('content-disposition', `${query.download === '1' ? 'attachment' : 'inline'}; filename="${asset.name}"`);
      return reply.type(asset.mimeType).send(contents);
    });
    await pool.get(defaultProjectId); // Eagerly open the default project so startup acquires the writer lock and validates its snapshots.
    return app;
  } catch (error) {
    await pool.close();
    throw error;
  }
}
