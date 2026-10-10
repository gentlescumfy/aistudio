import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from './domain.js';
import { atomicWrite } from './store.js';
import {
  defaultLangflowConfig, langflowConfigSchema,
  type LangflowConfig, type LangflowFlow, type LangflowRun, type LangflowRunRequest, type LangflowStatus,
} from './langflow-contract.js';
import { compileWorkflowToLangflow } from './langflow-compiler.js';
import type { Workflow, WorkflowDefinition } from './workflow-contract.js';

const configFileSchema = z.strictObject({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), config: langflowConfigSchema });
const flowSchema = z.strictObject({ id: z.uuid(), name: z.string().min(1).max(500), description: z.string().max(4000), updatedAt: z.iso.datetime({ offset: true }).nullable() });
const runSnapshotSchema = z.strictObject({ config: langflowConfigSchema, flow: flowSchema });
const storedRunSchema = z.strictObject({
  id: z.uuid(), flowId: z.uuid(), flowName: z.string().min(1).max(500), input: z.string().min(1).max(2000),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), output: z.string().max(16_000).nullable(),
  error: z.string().max(500).nullable(), provider: z.literal('langflow'), snapshot: runSnapshotSchema,
  jobId: z.string().optional(),
});
const ledgerSchema = z.strictObject({
  schemaVersion: z.literal(1), runs: z.array(storedRunSchema),
  submissions: z.array(z.strictObject({ key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), runId: z.uuid() })),
}).superRefine((ledger, context) => {
  const ids = new Set<string>(); const keys = new Set<string>();
  for (const run of ledger.runs) {
    if (ids.has(run.id)) context.addIssue({ code: 'custom', path: ['runs'], message: 'Run IDs must be unique.' });
    ids.add(run.id);
  }
  for (const submission of ledger.submissions) {
    if (keys.has(submission.key) || !ids.has(submission.runId)) context.addIssue({ code: 'custom', path: ['submissions'], message: 'Submissions must reference one run and use unique keys.' });
    keys.add(submission.key);
  }
});
type StoredRun = z.infer<typeof storedRunSchema>;
type Ledger = z.infer<typeof ledgerSchema>;
type PersistedConfig = z.infer<typeof configFileSchema>;
type Snapshot = StoredRun['snapshot'];

type UpstreamProblem = 'timeout' | 'transport' | 'credential-missing' | 'redirect' | 'http' | 'too-large' | 'invalid-json' | 'invalid-shape';
class UpstreamError extends Error {
  constructor(readonly problem: UpstreamProblem, readonly status?: number) { super(problem); }
}

export class LangflowService {
  private config: PersistedConfig = { schemaVersion: 1, revision: 0, config: structuredClone(defaultLangflowConfig) };
  private configTail: Promise<unknown> = Promise.resolve();
  private ledger: Ledger = { schemaVersion: 1, runs: [], submissions: [] };
  private ledgerTail: Promise<unknown> = Promise.resolve();
  private configFault: unknown;
  private ledgerFault: unknown;
  private stopping = false;
  private scheduled?: NodeJS.Immediate;
  private worker?: Promise<void>;
  private active?: AbortController;

  private constructor(private readonly directory: string, private readonly fetcher: typeof fetch, private readonly reportError: (message: string) => void) {}

  static async open(directory: string, fetcher: typeof fetch = fetch, reportError: (message: string) => void = () => undefined): Promise<LangflowService> {
    const service = new LangflowService(directory, fetcher, reportError);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const configText = await readFile(join(directory, 'langflow-config.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (configText !== undefined) service.config = configFileSchema.parse(JSON.parse(configText));
      const ledgerText = await readFile(join(directory, 'langflow-runs.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (ledgerText !== undefined) service.ledger = ledgerSchema.parse(JSON.parse(ledgerText));
      await service.recover();
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }

  readConfig(): { revision: number; config: LangflowConfig; credentialConfigured: boolean } {
    this.assertConfigAvailable();
    return { revision: this.config.revision, config: structuredClone(this.config.config), credentialConfigured: this.credentialConfigured(this.config.config) };
  }

  saveConfig(revision: number, config: LangflowConfig): Promise<{ revision: number; config: LangflowConfig; credentialConfigured: boolean }> {
    const validated = langflowConfigSchema.parse(config);
    const task = this.configTail.then(async () => {
      this.assertConfigAvailable();
      if (revision !== this.config.revision) throw new ApiError(409, 'LANGFLOW_CONFIG_CONFLICT', 'Langflow settings changed. Reload before saving.');
      const next: PersistedConfig = { schemaVersion: 1, revision: revision + 1, config: validated };
      try { await atomicWrite(join(this.directory, 'langflow-config.json'), JSON.stringify(next)); }
      catch (error) { this.configFault = error; throw new ApiError(503, 'LANGFLOW_CONFIG_STORAGE_UNAVAILABLE', 'Langflow settings could not be saved. Inspect local storage and restart the API.'); }
      this.config = next;
      return this.readConfig();
    });
    this.configTail = task.catch(() => undefined);
    return task;
  }

  async status(): Promise<LangflowStatus> {
    const { config } = this.readConfig();
    const base = { editorUrl: config.baseUrl, authMode: config.authMode };
    if (config.authMode === 'api-key-env' && !this.resolveApiKey(config)) {
      return { ...base, connected: false, version: null, message: 'The configured API-key environment variable is unavailable.' };
    }
    try {
      const [health, versionBody] = await Promise.all([
        this.requestJson(config, '/health_check', { authenticated: false }),
        this.requestJson(config, '/api/v1/version', { authenticated: true }),
      ]);
      const healthRecord = asRecord(health);
      const versionRecord = asRecord(versionBody);
      const version = stringField(versionRecord, ['version', 'main_version']);
      if (healthRecord?.status !== 'ok' || !version) {
        return { ...base, connected: false, version: version ?? null, message: 'Langflow returned an unsupported health or version response.' };
      }
      return { ...base, connected: true, version, message: 'Connected to the configured Langflow service.' };
    } catch (error) {
      return { ...base, connected: false, version: null, message: statusMessage(error) };
    }
  }

  async flows(): Promise<{ flows: LangflowFlow[] }> {
    const { config } = this.readConfig();
    this.requireApiKey(config);
    try { return { flows: await this.listFlows(config) }; }
    catch (error) { throw publicUpstreamError(error); }
  }

  runs(): { runs: LangflowRun[] } {
    this.assertLedgerAvailable();
    return { runs: [...this.ledger.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRun) };
  }

  run(id: string): LangflowRun {
    this.assertLedgerAvailable();
    const run = this.ledger.runs.find((item) => item.id === id);
    if (!run) throw new ApiError(404, 'LANGFLOW_RUN_NOT_FOUND', 'Langflow run not found.');
    return publicRun(run);
  }

  async cancel(id: string): Promise<LangflowRun> {
    this.assertLedgerAvailable();
    const run = this.ledger.runs.find((item) => item.id === id);
    if (!run) throw new ApiError(404, 'LANGFLOW_RUN_NOT_FOUND', 'Langflow run not found.');
    if (!['queued', 'running'].includes(run.status)) {
      throw new ApiError(409, 'CANNOT_CANCEL', `Run in '${run.status}' state cannot be cancelled.`);
    }

    const previousStatus = run.status;
    const jobId = run.jobId;
    const config = run.snapshot.config;

    // If currently running, abort active SSE stream
    if (previousStatus === 'running' && this.active) {
      this.active.abort();
    }

    const updated = await this.transactLedger((ledger) => {
      const target = ledger.runs.find((item) => item.id === id);
      if (!target || !['queued', 'running'].includes(target.status)) return target;
      target.status = 'cancelled';
      target.error = 'Run cancelled by user request.';
      target.updatedAt = new Date().toISOString();
      return target;
    });

    // Best-effort cancel propagation to Langflow upstream if job was dispatched
    if (previousStatus === 'running' && jobId) {
      this.requestJson(config, `/api/v1/build/${jobId}/cancel`, {
        authenticated: true,
        method: 'POST',
      }).catch(() => undefined);
    }

    return publicRun(updated ?? run);
  }

  async createRun(request: LangflowRunRequest): Promise<{ run: LangflowRun; replayed: boolean }> {
    this.assertLedgerAvailable();
    const fingerprint = createHash('sha256').update(JSON.stringify({ flowId: request.flowId, input: request.input })).digest('hex');
    const replay = this.lookup(request.idempotencyKey, fingerprint);
    if (replay) return { run: replay, replayed: true };

    this.assertConfigAvailable();
    const configSnapshot = structuredClone(this.config.config);
    this.requireApiKey(configSnapshot);
    let flow: LangflowFlow;
    try {
      flow = (await this.listFlows(configSnapshot)).find((candidate) => candidate.id === request.flowId)!;
    } catch (error) {
      const racedReplay = this.lookup(request.idempotencyKey, fingerprint);
      if (racedReplay) return { run: racedReplay, replayed: true };
      throw publicUpstreamError(error);
    }
    if (!flow) {
      const racedReplay = this.lookup(request.idempotencyKey, fingerprint);
      if (racedReplay) return { run: racedReplay, replayed: true };
      throw new ApiError(404, 'LANGFLOW_FLOW_NOT_FOUND', 'The selected flow is not available in Langflow.');
    }
    const now = new Date().toISOString();
    const snapshot: Snapshot = { config: configSnapshot, flow };
    const outcome = await this.transactLedger((ledger) => {
      const existing = ledger.submissions.find((entry) => entry.key === request.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different flow input.');
        const original = ledger.runs.find((run) => run.id === existing.runId)!;
        return { run: original, replayed: true };
      }
      const run: StoredRun = {
        id: randomUUID(), flowId: request.flowId, flowName: flow.name, input: request.input, status: 'queued',
        createdAt: now, updatedAt: now, output: null, error: null, provider: 'langflow', snapshot,
      };
      ledger.runs.push(run);
      ledger.submissions.push({ key: request.idempotencyKey, fingerprint, runId: run.id });
      return { run, replayed: false };
    });
    if (!outcome.replayed) this.schedule();
    return { run: publicRun(outcome.run), replayed: outcome.replayed };
  }

  async recover(): Promise<void> {
    this.assertLedgerAvailable();
    if (this.ledger.runs.some((run) => run.status === 'running')) {
      await this.transactLedger((ledger) => {
        for (const run of ledger.runs) if (run.status === 'running') {
          run.status = 'outcome_unknown';
          run.error = 'The API stopped during Langflow dispatch. Verify Langflow history; automatic resubmission is disabled.';
          run.updatedAt = new Date().toISOString();
        }
      });
    }
    if (this.ledger.runs.some((run) => run.status === 'queued')) this.schedule();
  }

  /**
   * Best-effort sync of this project into the configured Langflow instance.
   * Returns the Langflow project id on success, or null when Langflow is
   * unconfigured/unreachable — project creation must not depend on Langflow.
   */
  async createProject(name: string): Promise<{ langflowProjectId: string } | null> {
    try {
      const { config } = this.readConfig();
      this.requireApiKey(config);
      const data = await this.requestJson(config, '/api/v1/projects', { authenticated: true, method: 'POST', body: { name, description: `AI Studio project: ${name}` } });
      const id = asRecord(data)?.id;
      if (typeof id !== 'string' || !z.uuid().safeParse(id).success) return null;
      return { langflowProjectId: id };
    } catch (error) {
      this.reportError(`Langflow project sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Compiles an AI Studio workflow and publishes it to the configured Langflow instance.
   */
  async publishWorkflowToProject(
    projectId: string | null,
    workflow: Workflow | WorkflowDefinition,
  ): Promise<{ flowId: string }> {
    const { config } = this.readConfig();
    this.requireApiKey(config);
    const flowPayload = compileWorkflowToLangflow(workflow, {
      projectId: projectId ?? undefined,
      folderId: projectId ?? undefined,
    });
    try {
      const result = await this.requestJson(config, '/api/v1/flows/', {
        authenticated: true,
        method: 'POST',
        body: flowPayload,
      });
      const record = asRecord(result);
      const id = record?.id;
      if (typeof id !== 'string' || !z.uuid().safeParse(id).success) {
        throw new UpstreamError('invalid-shape');
      }
      return { flowId: id };
    } catch (error) {
      throw publicUpstreamError(error);
    }
  }

  private lookup(key: string, fingerprint: string): LangflowRun | undefined {
    const submission = this.ledger.submissions.find((entry) => entry.key === key);
    if (!submission) return undefined;
    if (submission.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different flow input.');
    const run = this.ledger.runs.find((entry) => entry.id === submission.runId);
    if (!run) throw new ApiError(503, 'LANGFLOW_LEDGER_INVALID', 'Langflow run history is inconsistent. Inspect local storage and restart the API.');
    return publicRun(run);
  }

  private async listFlows(config: LangflowConfig): Promise<LangflowFlow[]> {
    const data = await this.requestJson(config, '/api/v1/flows/?header_flows=true&get_all=false&page=1&size=100', { authenticated: true });
    const rows = Array.isArray(data) ? data : firstArray(asRecord(data), ['items', 'flows']);
    if (!rows) throw new UpstreamError('invalid-shape');
    return rows.map((value) => {
      const row = asRecord(value);
      if (!row) throw new UpstreamError('invalid-shape');
      const id = row.id;
      const name = typeof row.name === 'string' ? row.name : typeof row.title === 'string' ? row.title : undefined;
      const description = typeof row.description === 'string' ? row.description : '';
      const updated = row.updated_at ?? row.updatedAt ?? null;
      if (typeof id !== 'string' || !z.uuid().safeParse(id).success || !name || name.length > 500 || description.length > 4000) throw new UpstreamError('invalid-shape');
      const updatedAt = updated === null ? null : typeof updated === 'string' && z.iso.datetime({ offset: true }).safeParse(updated).success ? updated : undefined;
      if (updatedAt === undefined) throw new UpstreamError('invalid-shape');
      return { id, name, description, updatedAt };
    });
  }

  private async requestJson(config: LangflowConfig, path: string, options: { authenticated: boolean; method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
    const url = new URL(config.baseUrl);
    const prefix = url.pathname.replace(/\/+$/, '');
    const route = new URL(path, 'http://langflow.internal');
    url.pathname = `${prefix}${route.pathname}`;
    url.search = route.search;
    url.hash = '';
    const headers: Record<string, string> = { accept: 'application/json', 'accept-encoding': 'gzip, deflate, br' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.authenticated) {
      const key = this.resolveApiKey(config);
      if (config.authMode === 'api-key-env' && !key) throw new UpstreamError('credential-missing');
      if (key) headers['x-api-key'] = key;
    }
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    options.signal?.addEventListener('abort', relayAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let timer: NodeJS.Timeout | undefined;
    let response: Response | undefined;
    let timedOut = false;
    let rejectTimeout!: (error: UpstreamError) => void;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(new UpstreamError('timeout'));
    }, config.timeoutMs);
    timer.unref?.();
    try {
      const operation = async () => {
        response = await this.fetcher(url, {
          method: options.method ?? 'GET', headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          redirect: 'manual', signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          throw new UpstreamError('redirect', response.status);
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new UpstreamError('http', response.status);
        }
        const raw = await readBoundedBody(response, 2 * 1024 * 1024);
        try { return JSON.parse(new TextDecoder().decode(raw)); }
        catch { throw new UpstreamError('invalid-json'); }
      };
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(timedOut ? 'timeout' : 'transport');
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', relayAbort);
      if (controller.signal.aborted) await response?.body?.cancel().catch(() => undefined);
    }
  }

  private requireApiKey(config: LangflowConfig): void {
    if (config.authMode === 'api-key-env' && !this.resolveApiKey(config)) throw new ApiError(503, 'LANGFLOW_CREDENTIAL_UNAVAILABLE', 'The configured API-key environment variable is unavailable.');
  }

  private resolveApiKey(config: LangflowConfig): string | undefined {
    if (config.authMode !== 'api-key-env' || !config.secretEnv) return undefined;
    const value = process.env[config.secretEnv];
    return value && value.length > 0 ? value : undefined;
  }

  private credentialConfigured(config: LangflowConfig): boolean {
    return config.authMode === 'api-key-env' ? this.resolveApiKey(config) !== undefined : false;
  }

  private schedule(): void {
    if (this.stopping || this.scheduled || this.worker || this.ledgerFault) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.worker = this.drain().catch(() => {
        this.reportError('Langflow receipt storage failed. Queued execution has stopped until the API restarts.');
      }).finally(() => {
        this.worker = undefined;
        if (!this.stopping && !this.ledgerFault && this.ledger.runs.some((run) => run.status === 'queued')) this.schedule();
      });
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const stored = await this.transactLedger((ledger) => {
        const run = ledger.runs.find((candidate) => candidate.status === 'queued');
        if (!run) return undefined;
        run.status = 'running'; run.updatedAt = new Date().toISOString();
        return run;
      });
      if (!stored) return;
      await this.dispatch(stored);
    }
  }

  private async dispatch(run: StoredRun): Promise<void> {
    try {
      if (!run.jobId) {
        const result = await this.requestJson(run.snapshot.config, `/api/v1/build/${run.flowId}/flow`, {
          authenticated: true, method: 'POST', signal: this.setActiveController(),
          body: { inputs: { input_value: run.input, input_type: 'chat', output_type: 'chat' }, session_id: `studio-${run.id}` },
        });
        const jobId = asRecord(result)?.job_id || asRecord(result)?.id;
        if (typeof jobId !== 'string') throw new UpstreamError('invalid-shape');
        await this.transactLedger((ledger) => {
          const r = ledger.runs.find((item) => item.id === run.id && item.status === 'running');
          if (r) { r.jobId = jobId; r.updatedAt = new Date().toISOString(); }
        });
        run.jobId = jobId;
      }
      
      const output = await this.pollJobEvents(run.jobId, run.snapshot.config);
      await this.finish(run.id, 'succeeded', output, null);
    } catch (error) {
      const mapped = runFailure(error);
      await this.finish(run.id, mapped.status, null, mapped.message);
    } finally { this.active = undefined; }
  }

  private async pollJobEvents(jobId: string, config: LangflowConfig): Promise<string> {
    const url = new URL(config.baseUrl);
    const prefix = url.pathname.replace(/\/+$/, '');
    const route = new URL(`/api/v1/build/${jobId}/events`, 'http://langflow.internal');
    url.pathname = `${prefix}${route.pathname}`;
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    const key = this.resolveApiKey(config);
    if (key) headers['x-api-key'] = key;

    const controller = new AbortController();
    this.active = controller;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let rejectTimeout!: (error: UpstreamError) => void;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(new UpstreamError('timeout'));
    }, config.timeoutMs);
    timer.unref?.();

    try {
      const operation = async () => {
        const response = await this.fetcher(url, { method: 'GET', headers, signal: controller.signal });
        if (response.status >= 300 && response.status < 400) throw new UpstreamError('redirect', response.status);
        if (!response.ok) throw new UpstreamError('http', response.status);
        if (!response.body) throw new UpstreamError('invalid-shape');

        const reader = response.body.getReader();
        controller.signal.addEventListener('abort', () => {
          reader.cancel().catch(() => undefined);
        });
        const decoder = new TextDecoder();
        let buffer = '';
        let finalOutput: string | undefined = undefined;

        while (!this.stopping && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          
          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 2);
            
            const eventMatch = chunk.match(/^event:\s*(.+)$/m);
            const dataMatch = chunk.match(/^data:\s*(.+)$/m);
            
            if (eventMatch && dataMatch) {
              const eventType = eventMatch[1]?.trim() ?? '';
              const eventData = dataMatch[1]?.trim() ?? '';
              
              if (eventType === 'error') {
                 try {
                     const parsed = JSON.parse(eventData);
                     throw new Error(parsed.error || eventData);
                 } catch {
                     throw new Error(eventData);
                 }
              }
              
              try {
                const parsed = JSON.parse(eventData);
                if (parsed && Array.isArray(parsed.outputs)) {
                  finalOutput = decodeOutput(parsed);
                }
              } catch {}
            }
          }
        }
        if (finalOutput !== undefined) return finalOutput;
        throw new UpstreamError('invalid-shape');
      };
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(timedOut ? 'timeout' : 'transport');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private setActiveController(): AbortSignal {
    this.active = new AbortController();
    return this.active.signal;
  }

  private finish(id: string, status: StoredRun['status'], output: string | null, error: string | null): Promise<void> {
    return this.transactLedger((ledger) => {
      const run = ledger.runs.find((item) => item.id === id);
      if (!run || run.status !== 'running') return;
      run.status = status; run.output = output; run.error = error; run.updatedAt = new Date().toISOString();
    });
  }

  private transactLedger<T>(change: (ledger: Ledger) => T): Promise<T> {
    const task = this.ledgerTail.then(async () => {
      this.assertLedgerAvailable();
      const next = structuredClone(this.ledger);
      const result = change(next);
      ledgerSchema.parse(next);
      try { await atomicWrite(join(this.directory, 'langflow-runs.json'), JSON.stringify(next)); }
      catch (error) { this.ledgerFault = error; throw new ApiError(503, 'LANGFLOW_LEDGER_UNAVAILABLE', 'Langflow run history storage is unavailable. Inspect local storage and restart the API.'); }
      this.ledger = next;
      return structuredClone(result);
    });
    this.ledgerTail = task.catch(() => undefined);
    return task;
  }

  private assertConfigAvailable(): void {
    if (this.configFault) throw new ApiError(503, 'LANGFLOW_CONFIG_STORAGE_UNAVAILABLE', 'Langflow settings storage is unavailable. Inspect local storage and restart the API.');
  }

  private assertLedgerAvailable(): void {
    if (this.ledgerFault) throw new ApiError(503, 'LANGFLOW_LEDGER_UNAVAILABLE', 'Langflow run history storage is unavailable. Inspect local storage and restart the API.');
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.active?.abort();
    await this.worker;
    await this.configTail; await this.ledgerTail;
  }
}

function publicRun(run: StoredRun): LangflowRun {
  const { id, flowId, flowName, input, status, createdAt, updatedAt, output, error, provider } = run;
  return { id, flowId, flowName, input, status, createdAt, updatedAt, output, error, provider };
}

function publicUpstreamError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (!(error instanceof UpstreamError)) return new ApiError(502, 'LANGFLOW_UPSTREAM_ERROR', 'Langflow returned an unsupported response.');
  if (error.problem === 'timeout' || error.problem === 'transport') return new ApiError(503, 'LANGFLOW_UNAVAILABLE', 'Langflow could not be reached within the configured timeout.');
  if (error.problem === 'credential-missing') return new ApiError(503, 'LANGFLOW_CREDENTIAL_UNAVAILABLE', 'The configured API-key environment variable is unavailable.');
  if (error.problem === 'redirect') return new ApiError(502, 'LANGFLOW_REDIRECT_BLOCKED', 'Langflow redirected the request. Redirects are disabled for safety.');
  if (error.problem === 'http' && (error.status === 401 || error.status === 403)) return new ApiError(502, 'LANGFLOW_AUTH_FAILED', 'Langflow rejected the configured authentication.');
  if (error.problem === 'too-large') return new ApiError(502, 'LANGFLOW_RESPONSE_TOO_LARGE', 'Langflow response exceeded the configured size limit.');
  if (error.problem === 'invalid-shape' || error.problem === 'invalid-json') return new ApiError(502, 'LANGFLOW_RESPONSE_INVALID', 'Langflow returned an unsupported response shape.');
  return new ApiError(502, 'LANGFLOW_UPSTREAM_ERROR', 'Langflow rejected the request.');
}

function runFailure(error: unknown): { status: 'failed' | 'outcome_unknown'; message: string } {
  if (error instanceof UpstreamError) {
    if (error.problem === 'timeout' || error.problem === 'transport' || error.problem === 'too-large' || (error.problem === 'http' && (error.status ?? 0) >= 500)) {
      return { status: 'outcome_unknown', message: 'Langflow may have executed this flow. Verify Langflow history; automatic resubmission is disabled.' };
    }
    if (error.problem === 'http' && (error.status === 401 || error.status === 403)) return { status: 'failed', message: 'Langflow rejected the configured authentication.' };
    if (error.problem === 'http') return { status: 'failed', message: `Langflow rejected the execution request (HTTP ${error.status}).` };
    if (error.problem === 'redirect') return { status: 'failed', message: 'Langflow redirected the execution request; redirects are disabled.' };
    if (error.problem === 'invalid-shape' || error.problem === 'invalid-json') return { status: 'failed', message: 'Langflow returned an unsupported execution response shape.' };
  }
  return { status: 'failed', message: 'Langflow execution failed in the local adapter.' };
}

function statusMessage(error: unknown): string {
  if (error instanceof UpstreamError && error.problem === 'http' && (error.status === 401 || error.status === 403)) return 'Langflow rejected the configured authentication.';
  if (error instanceof UpstreamError && error.problem === 'redirect') return 'Langflow redirected the status request; redirects are disabled.';
  if (error instanceof UpstreamError && (error.problem === 'invalid-json' || error.problem === 'invalid-shape')) return 'Langflow returned an unsupported health or version response.';
  return 'Langflow is unreachable at the configured local endpoint.';
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  // Node fetch transparently decompresses supported encodings; enforce the limit on the decoded stream,
  // not Content-Length, which can describe only the compressed payload.
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => undefined); throw new UpstreamError('too-large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function decodeOutput(value: unknown): string {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.outputs)) throw new UpstreamError('invalid-shape');
  if (root.outputs.length === 0) return '';
  const texts: string[] = []; let recognized = false;
  for (const groupValue of root.outputs) {
    const group = asRecord(groupValue);
    if (!group || !Array.isArray(group.outputs)) continue;
    for (const outputValue of group.outputs) {
      const output = asRecord(outputValue); const results = asRecord(output?.results);
      if (!results) continue;
      const message = asRecord(results.message);
      const data = asRecord(message?.data);
      const text = typeof message?.text === 'string' ? message.text
        : typeof data?.text === 'string' ? data.text
          : typeof results.text === 'string' ? results.text
            : typeof results.output === 'string' ? results.output : undefined;
      if (message || typeof results.text === 'string' || typeof results.output === 'string') recognized = true;
      if (text !== undefined) texts.push(text);
    }
  }
  if (!recognized) throw new UpstreamError('invalid-shape');
  return texts.join('\n').slice(0, 16_000);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstArray(record: Record<string, unknown> | undefined, keys: string[]): unknown[] | undefined {
  for (const key of keys) if (Array.isArray(record?.[key])) return record![key] as unknown[];
  return undefined;
}

function stringField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return (record[key] as string).slice(0, 100);
  return undefined;
}
