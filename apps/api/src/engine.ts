import { createHash, randomUUID } from 'node:crypto';
import { ApiError, findRun, templates, touch, type Inputs, type Run } from './domain.js';
import type { FileStore } from './store.js';
import type { AssetStore } from './assets.js';
import { ProviderOutcomeUnknownError, type Provider, type ProviderOutput } from './provider.js';
import type { WorkflowStore } from './workflows.js';
import type { Workflow } from './workflow-contract.js';
import { TextAgentRuntime, type AgentCompletion } from './agent-runtime.js';
import type { Role } from './roles.js';
import type { AgentModelTarget } from './settings.js';

const unknownOutcome = 'PROVIDER_OUTCOME_UNKNOWN: manual reconciliation required; automatic resubmission disabled.';

export class RunEngine {
  private stopping = false;
  private fatal: unknown;
  private scheduled?: NodeJS.Immediate;
  private worker?: Promise<void>;
  private active?: { id: string; controller: AbortController };
  constructor(
    private readonly store: FileStore, private readonly assets: AssetStore,
    private readonly provider: Provider, private readonly logError: (error: unknown) => void,
    private readonly workflows?: WorkflowStore,
    private readonly resolveAgentTarget?: (selection: Role['modelSelection'], deadlineMs: number) => AgentModelTarget,
    private readonly textAgent: TextAgentRuntime = new TextAgentRuntime(),
  ) {}

  assertAvailable(): void {
    this.store.assertWritable();
    if (this.fatal || this.stopping) throw new ApiError(503, 'EXECUTOR_UNAVAILABLE', 'Executor unavailable. Restart after checking local storage.');
  }
  async recover(): Promise<void> {
    await this.store.transaction((db) => {
      for (const run of db.runs) {
        if (!['queued', 'running'].includes(run.status)) continue;
        const interrupted = run.nodes.find((node) => node.status === 'running');
        if (interrupted && (interrupted.agentTarget || this.provider.recovery !== 'safe-local-replay')) {
          run.status = 'failed'; run.error = unknownOutcome;
          interrupted.status = 'failed'; interrupted.error = unknownOutcome;
        } else {
          run.status = 'queued'; delete run.error;
          if (interrupted) { interrupted.status = 'pending'; delete interrupted.error; }
        }
        touch(run);
      }
    });
    this.schedule();
  }

  async create(templateId: string, inputs: Inputs, key: string, workflowRevision?: number): Promise<{ run: Run; replayed: boolean }> {
    this.assertAvailable();
    const request = { templateId, inputs, ...(workflowRevision === undefined ? {} : { workflowRevision }) };
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const result = await this.store.transaction((db) => {
      const submission = db.submissions.find((item) => item.key === key);
      if (submission) {
        if (submission.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different inputs.');
        return { run: findRun(db, submission.runId), replayed: true };
      }
      const template = templates.find((item) => item.id === templateId);
      let workflow: Workflow | undefined;
      if (template) {
        if (workflowRevision !== undefined) throw new ApiError(400, 'INVALID_WORKFLOW_REVISION', 'workflowRevision is only valid for a published workflow template.');
        if (!template.enabled) throw new ApiError(409, 'TEMPLATE_DISABLED', 'Template is coming soon and cannot execute.');
      } else {
        if (!this.workflows) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
        workflow = this.workflows.resolvePublished(templateId, workflowRevision);
      }
      const now = new Date().toISOString();
      const nodes: Run['nodes'] = workflow ? createWorkflowRunNodes(workflow, inputs, this.resolveAgentTarget) : template!.nodes.map((node) => ({ ...node, kind: node.kind as Run['nodes'][number]['kind'], status: 'pending' as const, attempts: 0 }));
      const callsAgent = nodes.some((node) => node.agentTarget !== undefined);
      const run: Run = {
        id: randomUUID(), templateId, status: 'queued', inputs,
        createdAt: now, updatedAt: now, mode: callsAgent ? 'mixed' : 'mock', assets: [], estimatedCost: callsAgent ? null : 0, actualCost: callsAgent ? null : 0,
        nodes,
        ...(workflow ? { workflowSnapshot: workflow, expectedAssetCount: workflow.nodes.filter((node) => node.kind === 'image').reduce((sum, node) => sum + (node.config.count ?? inputs.count), 0) } : {}),
      };
      db.runs.push(run);
      db.submissions.push({ key, fingerprint, runId: run.id });
      return { run, replayed: false };
    });
    this.schedule(); // Never schedule before the submission is durable.
    return result;
  }

  async retry(id: string): Promise<Run> {
    this.assertAvailable();
    const run = await this.store.transaction((db) => {
      const run = findRun(db, id);
      if (run.status !== 'failed') throw new ApiError(409, 'RUN_NOT_RETRYABLE', 'Only failed runs can be retried.');
      if (run.error === unknownOutcome) throw new ApiError(409, 'PROVIDER_OUTCOME_UNKNOWN', 'Resolve the provider outcome before retrying.');
      for (const node of run.nodes) {
        if (node.status === 'failed') { node.status = 'pending'; delete node.error; }
      }
      run.status = 'queued'; delete run.error; touch(run);
      return run;
    });
    this.schedule();
    return run;
  }

  async cancel(id: string): Promise<Run> {
    this.assertAvailable();
    const run = await this.store.transaction((db) => {
      const run = findRun(db, id);
      if (run.status === 'cancelled') return run;
      if (!['queued', 'running'].includes(run.status)) throw new ApiError(409, 'RUN_NOT_CANCELLABLE', 'Only queued or running runs can be cancelled.');
      run.status = 'cancelled'; touch(run);
      for (const node of run.nodes) {
        if (['pending', 'running'].includes(node.status)) {
          if (node.status === 'running' && node.agentTarget) node.error = unknownOutcome;
          node.status = 'cancelled';
        }
      }
      return run;
    });
    if (this.active?.id === id) this.active.controller.abort();
    return run;
  }

  private schedule(): void {
    if (this.stopping || this.fatal || this.scheduled || this.worker) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.worker = this.drain().catch((error: unknown) => {
        this.fatal = error; this.logError(error); // Storage failure: halt, do not execute uncommitted work.
      }).finally(() => {
        this.worker = undefined;
        if (this.store.snapshot().runs.some((run) => run.status === 'queued')) this.schedule();
      });
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const queued = this.store.snapshot().runs.find((run) => run.status === 'queued');
      if (!queued) return;
      await this.execute(queued.id);
    }
  }

  private async execute(id: string): Promise<void> {
    const controller = new AbortController();
    this.active = { id, controller };
    try {
      while (!this.stopping && !controller.signal.aborted) {
        const run = await this.store.transaction((db) => {
          const run = findRun(db, id);
          if (!['queued', 'running'].includes(run.status)) return undefined;
          const pending = run.nodes.filter((node) => node.status === 'pending');
          const next = pending.find((node) => (node.dependsOn ?? []).every((dependency) => run.nodes.find((candidate) => candidate.id === dependency)?.status === 'succeeded'));
          if (!next) {
            if (pending.length) {
              const blocked = pending[0]!;
              blocked.status = 'failed'; blocked.error = 'WORKFLOW_NO_READY_NODE: dependency state is corrupt.';
              run.status = 'failed'; run.error = blocked.error;
            } else if (run.nodes.every((node) => node.status === 'succeeded')) run.status = 'succeeded';
            else { run.status = 'failed'; run.error = 'WORKFLOW_INCOMPLETE: node state is corrupt.'; }
            touch(run);
            return undefined;
          }
          run.status = 'running'; next.status = 'running'; next.attempts++; touch(run);
          return run;
        });
        if (!run || this.stopping || controller.signal.aborted) return;
        const node = run.nodes.find((item) => item.status === 'running')!;
        let output: ProviderOutput[];
        let agentCompletion: AgentCompletion | undefined;
        try {
          if (node.agentTarget) {
            const role = run.workflowSnapshot?.roleSnapshots.find((item) => item.nodeId === node.id)?.role;
            if (!role || node.kind !== 'prompt') throw new Error('代理角色快照缺失，无法执行此步骤。');
            agentCompletion = await this.textAgent.execute(role, node.outputPrompt ?? run.inputs.prompt, node.agentTarget, controller.signal);
            output = [];
          } else output = await this.provider.execute(run, node, controller.signal);
        } catch (error) {
          if (this.stopping || controller.signal.aborted) return;
          // Provider failures are distinct from persistence failures and can be retried.
          await this.store.transaction((db) => {
            const current = findRun(db, id);
            if (current.status !== 'running') return;
            const failed = current.nodes.find((item) => item.id === node.id)!;
            failed.status = 'failed';
            failed.error = error instanceof ProviderOutcomeUnknownError ? unknownOutcome : error instanceof Error ? error.message : 'Mock provider failed.';
            current.status = 'failed'; current.error = failed.error; touch(current);
          });
          return;
        }
        if (this.stopping || controller.signal.aborted) return;
        for (const item of output) {
          if (this.stopping || controller.signal.aborted) return;
          await this.assets.write(item);
        }
        if (this.stopping || controller.signal.aborted) return;
        await this.store.transaction((db) => {
          const current = findRun(db, id);
          if (current.status !== 'running') return;
          const completed = current.nodes.find((item) => item.id === node.id)!;
          completed.status = 'succeeded';
          if (agentCompletion) {
            completed.agentOutput = agentCompletion.text;
            completed.agentExecution = {
              providerName: agentCompletion.providerName,
              modelName: agentCompletion.modelName,
              completedAt: agentCompletion.completedAt,
            };
          }
          // IDs and paths are deterministic; interrupted mock writes are safely replaced.
          for (const item of output) {
            if (!current.assets.some((asset) => asset.id === item.asset.id)) current.assets.push(item.asset);
          }
          propagateNodeOutput(current, completed);
          touch(current);
        });
      }
    } finally { this.active = undefined; }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.active?.controller.abort();
    await this.worker;
  }
}

function createWorkflowRunNodes(
  workflow: Workflow,
  inputs: Inputs,
  resolveAgentTarget?: (selection: Role['modelSelection'], deadlineMs: number) => AgentModelTarget,
): Run['nodes'] {
  const indegree = new Map(workflow.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(workflow.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of workflow.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) throw new ApiError(400, 'INVALID_WORKFLOW', 'Published workflow contains a dangling connection.');
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const ready = workflow.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const target of outgoing.get(id)!) {
      const next = indegree.get(target)! - 1; indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (order.length !== workflow.nodes.length) throw new ApiError(400, 'INVALID_WORKFLOW', 'Published workflow contains a cycle.');
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const prepared = new Map<string, Run['nodes'][number]>();
  for (const id of order) {
    const source = nodes.get(id)!;
    const dependsOn = workflow.edges.filter((edge) => edge.target === id).map((edge) => edge.source);
    const node: Run['nodes'][number] = {
      id: source.id, name: source.name, kind: source.kind, status: 'pending', attempts: 0,
      config: structuredClone(source.config), dependsOn,
    };
    if (source.kind === 'prompt') {
      const parent = dependsOn.length ? prepared.get(dependsOn[0]!) : undefined;
      if (dependsOn.length && (!parent || parent.kind !== 'prompt' || parent.outputPrompt === undefined)) throw new ApiError(400, 'INVALID_WORKFLOW', 'Prompt dependency has no resolved prompt output.');
      const value = parent?.outputPrompt ?? inputs.prompt;
      const expanded = source.config.template.replace(/{{\s*(prompt|count)\s*}}/g, (_match, key: string) => key === 'prompt' ? value : String(inputs.count));
      if (expanded.length > 16_000) throw new ApiError(400, 'PROMPT_TOO_LARGE', 'Expanded workflow prompt exceeds 16000 characters.');
      node.outputPrompt = expanded;
      if (source.config.executionMode === 'agent') {
        const role = workflow.roleSnapshots.find((snapshot) => snapshot.nodeId === source.id)?.role;
        if (!role) throw new ApiError(409, 'AGENT_ROLE_SNAPSHOT_MISSING', `节点“${source.name}”没有已发布的代理角色快照，请重新发布工作流。`);
        if (!resolveAgentTarget) throw new ApiError(503, 'AGENT_RUNTIME_UNAVAILABLE', '代理运行时不可用，请重启 AI Studio API。');
        node.agentTarget = resolveAgentTarget(role.modelSelection, role.limits.deadlineMs);
      }
    } else if (source.kind === 'image') {
      const parent = dependsOn.length === 1 ? prepared.get(dependsOn[0]!) : undefined;
      if (!parent || parent.kind !== 'prompt' || parent.outputPrompt === undefined) throw new ApiError(400, 'INVALID_WORKFLOW', 'Image dependency has no resolved prompt output.');
      node.outputPrompt = parent.outputPrompt;
    }
    prepared.set(id, node);
  }
  return order.map((id) => prepared.get(id)!);
}

function propagateNodeOutput(run: Run, completed: Run['nodes'][number]): void {
  const text = completed.agentOutput ?? completed.outputPrompt;
  if (text === undefined) return;
  for (const dependent of run.nodes.filter((node) => (node.dependsOn ?? []).includes(completed.id))) {
    if (dependent.kind === 'image') {
      dependent.outputPrompt = text;
      continue;
    }
    if (dependent.kind !== 'prompt' || !dependent.config || !('template' in dependent.config)) continue;
    const expanded = dependent.config.template.replace(/{{\s*(prompt|count)\s*}}/g, (_match, key: string) => key === 'prompt' ? text : String(run.inputs.count));
    if (expanded.length > 16_000) {
      dependent.status = 'failed';
      dependent.error = 'PROMPT_TOO_LARGE: 上游代理输出展开后超过 16000 个字符。';
      run.status = 'failed';
      run.error = dependent.error;
      return;
    }
    dependent.outputPrompt = expanded;
  }
}
