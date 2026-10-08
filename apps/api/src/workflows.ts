import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from './domain.js';
import { atomicWrite } from './store.js';
import {
  starterDefinition, workflowDefinitionSchema, workflowRecordSchema,
  type GraphIssue, type Workflow, type WorkflowDefinition, type WorkflowTemplate, type WorkflowValidation,
} from './workflow-contract.js';
import type { Role } from './roles.js';

const workflowHistorySchema = z.strictObject({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), workflowHistory: z.array(workflowRecordSchema),
}).superRefine((state, context) => {
  if (state.workflowHistory.length !== state.revision) context.addIssue({ code: 'custom', path: ['revision'], message: 'Catalogue revision must match committed workflow changes.' });
  const byId = new Map<string, Workflow[]>();
  state.workflowHistory.forEach((workflow, index) => {
    const history = byId.get(workflow.id) ?? [];
    if (workflow.revision !== history.length + 1 || (history.length && (history.at(-1)!.lifecycle === 'archived' || workflow.createdAt !== history[0]!.createdAt))) {
      context.addIssue({ code: 'custom', path: ['workflowHistory', index], message: 'Workflow revisions must be contiguous and archived workflows immutable.' });
    }
    history.push(workflow); byId.set(workflow.id, history);
  });
  for (const [id, history] of byId) {
    for (const workflow of history) {
      if (workflow.lifecycle === 'published' && workflow.publishedRevision !== workflow.revision) {
        context.addIssue({ code: 'custom', path: ['workflowHistory'], message: `Published workflow ${id} must point to its own revision.` });
      }
      if (workflow.publishedRevision !== null && !history.some((entry) => entry.revision === workflow.publishedRevision && entry.lifecycle === 'published')) {
        context.addIssue({ code: 'custom', path: ['workflowHistory'], message: `Workflow ${id} points to a missing published revision.` });
      }
      for (const snapshot of workflow.roleSnapshots) {
        const prompt = workflow.nodes.find((node) => node.id === snapshot.nodeId);
        if (prompt?.kind !== 'prompt' || prompt.config.roleRef?.id !== snapshot.role.id || prompt.config.roleRef.revision !== snapshot.role.revision) {
          context.addIssue({ code: 'custom', path: ['workflowHistory'], message: `Workflow ${id} contains an inconsistent role snapshot.` });
        }
      }
    }
  }
  if (byId.size > 64) context.addIssue({ code: 'custom', path: ['workflowHistory'], message: 'At most 64 custom workflows are supported.' });
});
type WorkflowState = z.infer<typeof workflowHistorySchema>;
export type ResolvedRoleRevision = { role: Role; currentLifecycle: Role['lifecycle'] };
export type RoleRevisionResolver = (id: string, revision: number) => ResolvedRoleRevision | undefined;

export class WorkflowStore {
  private state: WorkflowState = { schemaVersion: 1, revision: 0, workflowHistory: [] };
  private tail: Promise<unknown> = Promise.resolve();
  private fault: unknown;
  private constructor(private readonly path: string) {}

  static async open(directory: string): Promise<WorkflowStore> {
    const store = new WorkflowStore(join(directory, 'workflows.json'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let contents: string;
    try { contents = await readFile(store.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store; throw error; }
    store.state = workflowHistorySchema.parse(JSON.parse(contents));
    return store;
  }

  assertAvailable(): void {
    if (this.fault) throw new ApiError(503, 'WORKFLOW_STORAGE_UNAVAILABLE', 'Workflow storage is unavailable. Inspect local storage and restart the API.');
  }

  read(): { revision: number; workflows: Workflow[]; starterDefinition: WorkflowDefinition; runtime: { mode: 'mixed'; executableKinds: ['prompt', 'image', 'export']; agentExecutionEnabled: true } } {
    this.assertAvailable();
    const latest = new Map<string, Workflow>();
    for (const workflow of this.state.workflowHistory) {
      if (!latest.has(workflow.id) || latest.get(workflow.id)!.revision < workflow.revision) latest.set(workflow.id, workflow);
    }
    return {
      revision: this.state.revision,
      workflows: structuredClone([...latest.values()]),
      starterDefinition: structuredClone(starterDefinition),
      runtime: { mode: 'mixed', executableKinds: ['prompt', 'image', 'export'], agentExecutionEnabled: true },
    };
  }

  revisions(id: string): Workflow[] {
    this.assertAvailable();
    const result = this.state.workflowHistory.filter((workflow) => workflow.id === id).sort((a, b) => a.revision - b.revision);
    if (!result.length) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
    return structuredClone(result);
  }

  validate(definition: WorkflowDefinition, resolveRole: RoleRevisionResolver): WorkflowValidation {
    this.assertAvailable();
    return validateWorkflow(definition, resolveRole);
  }

  create(revision: number, definition: WorkflowDefinition): Promise<{ revision: number; workflow: Workflow }> {
    return this.transact(revision, (state) => {
      if (new Set(state.workflowHistory.map((entry) => entry.id)).size >= 64) throw new ApiError(409, 'WORKFLOW_LIMIT_REACHED', 'At most 64 custom workflows are supported.');
      const now = new Date().toISOString();
      const workflow: Workflow = { ...structuredClone(definition), id: randomUUID(), revision: 1, lifecycle: 'draft', publishedRevision: null, createdAt: now, updatedAt: now, roleSnapshots: [] };
      state.workflowHistory.push(workflow); state.revision++;
      return { revision: state.revision, workflow };
    });
  }

  edit(id: string, revision: number, definition: WorkflowDefinition): Promise<{ revision: number; workflow: Workflow }> {
    return this.transact(revision, (state) => {
      const current = latestWorkflow(state, id);
      if (!current) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      if (current.lifecycle === 'archived') throw new ApiError(409, 'WORKFLOW_ARCHIVED', 'Archived workflows cannot be edited.');
      const workflow: Workflow = { ...structuredClone(definition), id, revision: current.revision + 1, lifecycle: 'draft', publishedRevision: current.publishedRevision, createdAt: current.createdAt, updatedAt: laterTimestamp(current.updatedAt), roleSnapshots: [] };
      state.workflowHistory.push(workflow); state.revision++;
      return { revision: state.revision, workflow };
    });
  }

  publish(id: string, revision: number, resolveRole: RoleRevisionResolver): Promise<{ revision: number; workflow: Workflow }> {
    return this.transact(revision, (state) => {
      const current = latestWorkflow(state, id);
      if (!current) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      if (current.lifecycle === 'archived') throw new ApiError(409, 'WORKFLOW_ARCHIVED', 'Archived workflows cannot be published.');
      const validation = validateWorkflow(definitionOf(current), resolveRole);
      if (!validation.valid) throw new ApiError(400, 'INVALID_WORKFLOW', validation.issues.map((issue) => issue.message).join(' '));
      const roleSnapshots = current.nodes.flatMap((node) => {
        if (node.kind !== 'prompt' || !node.config.roleRef) return [];
        const resolved = resolveRole(node.config.roleRef.id, node.config.roleRef.revision)!;
        return [{ nodeId: node.id, role: structuredClone(resolved.role) as unknown as Workflow['roleSnapshots'][number]['role'] }];
      });
      const workflow: Workflow = { ...structuredClone(current), revision: current.revision + 1, lifecycle: 'published', publishedRevision: current.revision + 1, updatedAt: laterTimestamp(current.updatedAt), roleSnapshots };
      state.workflowHistory.push(workflow); state.revision++;
      return { revision: state.revision, workflow };
    });
  }

  archive(id: string, revision: number): Promise<{ revision: number; workflow: Workflow }> {
    return this.transact(revision, (state) => {
      const current = latestWorkflow(state, id);
      if (!current) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found.');
      if (current.lifecycle === 'archived') return { revision: state.revision, workflow: current };
      const workflow: Workflow = { ...structuredClone(current), revision: current.revision + 1, lifecycle: 'archived', updatedAt: laterTimestamp(current.updatedAt) };
      state.workflowHistory.push(workflow); state.revision++;
      return { revision: state.revision, workflow };
    });
  }

  templates(): WorkflowTemplate[] {
    this.assertAvailable();
    return [...this.latestValues()]
      .filter((workflow) => workflow.lifecycle !== 'archived' && workflow.publishedRevision !== null)
      .flatMap((workflow) => {
        const published = this.published(workflow.id, workflow.publishedRevision!);
        if (!published) return [];
        return [{ id: workflow.id, name: published.name, description: published.description, category: 'image', enabled: true, nodes: published.nodes.map(({ id, name, kind }) => ({ id, name, kind })), workflowRevision: published.revision, source: 'workflow', agentNodeCount: published.nodes.filter((node) => node.kind === 'prompt' && node.config.executionMode === 'agent').length }];
      });
  }

  resolvePublished(id: string, requestedRevision?: number): Workflow {
    this.assertAvailable();
    const latest = latestWorkflow(this.state, id);
    if (!latest) throw new ApiError(404, 'TEMPLATE_NOT_FOUND', 'Workflow template not found.');
    if (latest.lifecycle === 'archived') throw new ApiError(409, 'TEMPLATE_DISABLED', 'Archived workflow templates cannot start new runs.');
    const revision = requestedRevision ?? latest.publishedRevision;
    if (revision === null || revision === undefined) throw new ApiError(409, 'TEMPLATE_DISABLED', 'Workflow has no published revision.');
    const published = this.published(id, revision);
    if (!published) throw new ApiError(404, 'WORKFLOW_REVISION_NOT_FOUND', 'Published workflow revision not found.');
    return structuredClone(published);
  }

  private published(id: string, revision: number): Workflow | undefined {
    return this.state.workflowHistory.find((workflow) => workflow.id === id && workflow.revision === revision && workflow.lifecycle === 'published');
  }

  private latestValues(): Workflow[] {
    const latest = new Map<string, Workflow>();
    for (const workflow of this.state.workflowHistory) if (!latest.has(workflow.id) || latest.get(workflow.id)!.revision < workflow.revision) latest.set(workflow.id, workflow);
    return [...latest.values()];
  }

  private transact<T>(revision: number, change: (state: WorkflowState) => T): Promise<T> {
    const task = this.tail.then(async () => {
      this.assertAvailable();
      if (revision !== this.state.revision) throw new ApiError(409, 'WORKFLOW_LIBRARY_CONFLICT', 'The workflow library changed. Reload before saving.');
      const next = structuredClone(this.state);
      const result = change(next);
      workflowHistorySchema.parse(next);
      try { await atomicWrite(this.path, JSON.stringify(next)); }
      catch (error) { this.fault = error; throw error; }
      this.state = next;
      return structuredClone(result);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> { await this.tail; }
}

export function validateWorkflow(definition: WorkflowDefinition, resolveRole: RoleRevisionResolver): WorkflowValidation {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    return { valid: false, issues: parsed.error.issues.map((issue) => ({ code: 'INVALID_DEFINITION', message: `${issue.path.join('.') || 'workflow'}: ${issue.message}` })), warnings: [] };
  }
  const issues: GraphIssue[] = [];
  const nodes = definition.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, [] as typeof definition.edges]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as typeof definition.edges]));
  const pairs = new Set<string>();
  const add = (code: string, message: string, nodeId?: string, edgeId?: string) => issues.push({ code, message, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) });
  for (const edge of definition.edges) {
    const source = byId.get(edge.source); const target = byId.get(edge.target);
    if (!source || !target) { add('DANGLING_EDGE', `Edge ${edge.id} references a missing node.`, undefined, edge.id); continue; }
    if (edge.source === edge.target) add('SELF_LOOP', `Edge ${edge.id} cannot connect a node to itself.`, edge.source, edge.id);
    const pair = `${edge.source}\u0000${edge.target}`;
    if (pairs.has(pair)) add('DUPLICATE_EDGE', `Duplicate connection ${edge.source} → ${edge.target}.`, target.id, edge.id);
    pairs.add(pair); incoming.get(target.id)!.push(edge); outgoing.get(source.id)!.push(edge);
    const allowed = (source.kind === 'prompt' && target.kind === 'prompt') || (source.kind === 'prompt' && target.kind === 'image') || (source.kind === 'image' && target.kind === 'export');
    if (!allowed) add('INVALID_EDGE_KIND', `Connection ${source.kind} → ${target.kind} is not allowed.`, target.id, edge.id);
  }
  const roots = nodes.filter((node) => node.kind === 'prompt' && incoming.get(node.id)!.length === 0);
  const exports = nodes.filter((node) => node.kind === 'export' && outgoing.get(node.id)!.length === 0);
  const images = nodes.filter((node) => node.kind === 'image');
  if (roots.length !== 1) add('ROOT_COUNT', 'A published workflow must have exactly one root prompt node.');
  if (exports.length !== 1) add('EXPORT_COUNT', 'A published workflow must have exactly one terminal export node.');
  if (!images.length) add('IMAGE_REQUIRED', 'A published workflow must include at least one image node.');
  for (const node of nodes) {
    const ins = incoming.get(node.id)!;
    if (node.kind === 'prompt') {
      if (node.config.executionMode === 'agent' && !node.config.roleRef) add('AGENT_ROLE_REQUIRED', `代理步骤“${node.name}”必须绑定一个角色版本。`, node.id);
      if (ins.filter((edge) => byId.get(edge.source)?.kind === 'prompt').length > 1) add('PROMPT_PARENT_LIMIT', 'Prompt nodes can receive at most one prompt parent.', node.id);
      const placeholders = [...node.config.template.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]!);
      for (const placeholder of placeholders) if (!['prompt', 'count'].includes(placeholder)) add('UNKNOWN_PLACEHOLDER', `Unknown prompt placeholder {{${placeholder}}}.`, node.id);
      const withoutValidPlaceholders = node.config.template.replace(/{{\s*(prompt|count)\s*}}/g, '');
      if (/{{|}}/.test(withoutValidPlaceholders)) add('INVALID_PLACEHOLDER', 'Prompt placeholders must use {{prompt}} or {{count}}.', node.id);
      if (node.config.roleRef) {
        const role = resolveRole(node.config.roleRef.id, node.config.roleRef.revision);
        if (!role) add('ROLE_REVISION_NOT_FOUND', `Prompt node ${node.name} references a missing role revision.`, node.id);
        else if (role.currentLifecycle === 'archived') add('ROLE_CURRENT_ARCHIVED', `Prompt node ${node.name} references a role that is currently archived.`, node.id);
        else if (role.role.lifecycle === 'archived') add('ROLE_REVISION_ARCHIVED', `Prompt node ${node.name} references an archived role revision.`, node.id);
        else if (node.config.executionMode === 'agent' && role.role.modelStatus === 'unavailable') add('AGENT_ROLE_MODEL_UNAVAILABLE', `代理角色“${role.role.name}”绑定的模型已不可用。`, node.id);
      }
    } else if (node.kind === 'image') {
      if (ins.length !== 1 || byId.get(ins[0]?.source ?? '')?.kind !== 'prompt') add('IMAGE_PROMPT_PARENT', 'Each image node must receive exactly one prompt parent.', node.id);
    } else if (ins.length < 1 || ins.some((edge) => byId.get(edge.source)?.kind !== 'image')) {
      add('EXPORT_IMAGE_PARENTS', 'The export node must receive one or more image parents.', node.id);
    }
  }
  const indegree = new Map(nodes.map((node) => [node.id, incoming.get(node.id)!.filter((edge) => byId.has(edge.source)).length]));
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const topological: string[] = [];
  while (queue.length) {
    const id = queue.shift()!; topological.push(id);
    for (const edge of outgoing.get(id)!) {
      const degree = indegree.get(edge.target);
      if (degree === undefined) continue;
      indegree.set(edge.target, degree - 1);
      if (degree - 1 === 0) queue.push(edge.target);
    }
  }
  if (topological.length !== nodes.length) add('CYCLE', 'Workflow graph must be acyclic.');
  if (roots.length === 1 && exports.length === 1) {
    const walk = (start: string, map: Map<string, typeof definition.edges>, direction: 'source' | 'target') => {
      const seen = new Set<string>(); const pending = [start];
      while (pending.length) {
        const current = pending.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const edge of map.get(current) ?? []) pending.push(direction === 'source' ? edge.source : edge.target);
      }
      return seen;
    };
    const fromRoot = walk(roots[0]!.id, outgoing, 'target');
    const toExport = walk(exports[0]!.id, incoming, 'source');
    for (const node of nodes) if (!fromRoot.has(node.id) || !toExport.has(node.id)) add('DISCONNECTED_NODE', `Node ${node.name} is not on a path from the root prompt to export.`, node.id);
  }
  const roleCount = nodes.filter((node) => node.kind === 'prompt' && node.config.roleRef).length;
  const agentCount = nodes.filter((node) => node.kind === 'prompt' && node.config.executionMode === 'agent').length;
  return {
    valid: issues.length === 0,
    issues,
    warnings: [
      ...(agentCount ? ['代理节点将调用已配置的 OpenAI 兼容文本模型；图像仍使用本地 SVG 模拟，角色工具声明不会执行。'] : []),
      ...(roleCount > agentCount ? ['仅选择“模板处理”的角色引用只保存职责和版本快照，不会调用代理。'] : []),
    ],
  };
}

function latestWorkflow(state: WorkflowState, id: string): Workflow | undefined {
  return state.workflowHistory.filter((workflow) => workflow.id === id).reduce<Workflow | undefined>((latest, current) => !latest || current.revision > latest.revision ? current : latest, undefined);
}

function definitionOf(workflow: Workflow): WorkflowDefinition {
  return { name: workflow.name, description: workflow.description, nodes: workflow.nodes, edges: workflow.edges };
}

function laterTimestamp(previous: string): string {
  const previousTime = Date.parse(previous); const now = Date.now();
  return new Date(Math.max(now, previousTime + 1)).toISOString();
}
