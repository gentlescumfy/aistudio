import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from './domain.js';
import { atomicWrite } from './store.js';
import type { ModelBinding } from './settings.js';

export const toolDefinitions = [
  { id: 'assets.read', name: 'Read assets', description: 'Declare intended access to existing project assets.', risk: 'read', executable: false },
  { id: 'context.search', name: 'Search context', description: 'Declare intended retrieval from approved project context.', risk: 'read', executable: false },
  { id: 'images.generate', name: 'Generate images', description: 'Declare intended image-generation permission for a future runtime.', risk: 'generate', executable: false },
  { id: 'media.render', name: 'Render media', description: 'Declare intended rendering permission for a future runtime.', risk: 'write', executable: false },
  { id: 'code.read', name: 'Read code', description: 'Declare intended read-only repository access for a future runtime.', risk: 'read', executable: false },
  { id: 'code.edit', name: 'Edit code', description: 'Declare intended isolated code-editing permission for a future runtime.', risk: 'write', executable: false },
  { id: 'code.test', name: 'Run tests', description: 'Declare intended bounded test execution for a future runtime.', risk: 'write', executable: false },
] as const;

const toolIds = toolDefinitions.map((tool) => tool.id);
const categories = ['media', 'engineering', 'operations', 'custom'] as const;
const toolIdSchema = z.enum(toolIds);
const modelSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inherit') }),
  z.strictObject({ kind: z.literal('binding'), binding: z.strictObject({
    providerId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    accountId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    modelId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  }) }),
]);

export const roleDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  category: z.enum(categories),
  description: z.string().trim().min(1).max(1000),
  systemPrompt: z.string().trim().min(1).max(6000),
  inputContract: z.string().trim().min(1).max(4000),
  outputContract: z.string().trim().min(1).max(4000),
  tools: z.array(toolIdSchema).max(toolIds.length).superRefine((tools, context) => {
    if (new Set(tools).size !== tools.length) context.addIssue({ code: 'custom', message: 'Tool declarations must be unique.' });
  }),
  modelSelection: modelSelectionSchema,
  limits: z.strictObject({
    maxSteps: z.number().int().min(1).max(100),
    maxToolCalls: z.number().int().min(0).max(1000),
    deadlineMs: z.number().int().min(1000).max(3_600_000),
    maxCost: z.number().min(0).max(1000),
  }),
});

export const roleRecordSchema = roleDefinitionSchema.safeExtend({
  id: z.string().min(1).max(64),
  revision: z.number().int().positive(),
  builtIn: z.boolean(),
  lifecycle: z.enum(['draft', 'published', 'archived']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const persistedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  roleHistory: z.array(roleRecordSchema),
}).superRefine((snapshot, context) => {
  const builtInIds = new Set(builtInRoleRecords.map((role) => role.id));
  const versions = new Set<string>();
  const historyByRole = new Map<string, z.infer<typeof roleRecordSchema>[]>();
  for (let index = 0; index < snapshot.roleHistory.length; index++) {
    const role = snapshot.roleHistory[index]!;
    if (role.builtIn !== builtInIds.has(role.id)) {
      context.addIssue({ code: 'custom', path: ['roleHistory', index], message: 'Role IDs and builtIn flags are inconsistent.' });
    }
    if (role.builtIn && (role.revision !== 1 || role.lifecycle !== 'published')) {
      context.addIssue({ code: 'custom', path: ['roleHistory', index], message: 'Built-in roles have one published read-only revision.' });
    }
    if (!role.builtIn && !z.uuid().safeParse(role.id).success) {
      context.addIssue({ code: 'custom', path: ['roleHistory', index, 'id'], message: 'Custom role IDs must be UUIDs.' });
    }
    const key = `${role.id}\u0000${role.revision}`;
    if (versions.has(key)) context.addIssue({ code: 'custom', path: ['roleHistory', index], message: 'Role revisions must be unique.' });
    versions.add(key);
    const history = historyByRole.get(role.id) ?? [];
    history.push(role); historyByRole.set(role.id, history);
    if (role.builtIn && !matchesBuiltIn(role)) {
      context.addIssue({ code: 'custom', path: ['roleHistory', index], message: 'Built-in role contents are immutable.' });
    }
  }

  for (const baseline of builtInRoleRecords) {
    const history = historyByRole.get(baseline.id) ?? [];
    if (history.length !== 1 || history[0]!.revision !== 1) {
      context.addIssue({ code: 'custom', path: ['roleHistory'], message: `Missing or duplicated built-in role ${baseline.id}.` });
    }
  }
  let customCount = 0;
  for (const [id, history] of historyByRole) {
    if (builtInIds.has(id)) continue;
    customCount++;
    history.sort((a, b) => a.revision - b.revision);
    if (history[0]!.revision !== 1) context.addIssue({ code: 'custom', path: ['roleHistory'], message: 'Custom roles start at revision 1.' });
    for (let index = 1; index < history.length; index++) {
      const previous = history[index - 1]!; const current = history[index]!;
      if (current.revision !== previous.revision + 1 || previous.lifecycle === 'archived' || current.createdAt !== history[0]!.createdAt) {
        context.addIssue({ code: 'custom', path: ['roleHistory'], message: 'Custom role history must be contiguous and archived roles immutable.' });
      }
    }
  }
  if (customCount > 64) context.addIssue({ code: 'custom', path: ['roleHistory'], message: 'At most 64 custom roles are supported.' });
  if (snapshot.roleHistory.length !== builtInRoleRecords.length + snapshot.revision) {
    context.addIssue({ code: 'custom', path: ['revision'], message: 'Library revision must match the number of committed role changes.' });
  }
});

export const createRoleRequestSchema = z.strictObject({ revision: z.number().int().nonnegative(), role: roleDefinitionSchema });
export const editRoleRequestSchema = createRoleRequestSchema;
export const archiveRoleRequestSchema = z.strictObject({ revision: z.number().int().nonnegative() });

export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;
export type RoleRecord = z.infer<typeof roleRecordSchema>;
export type Role = RoleRecord & { modelStatus: 'inherit' | 'configured' | 'unavailable' };
type RoleHistorySnapshot = z.infer<typeof persistedSchema>;
export type ModelStatusResolver = (binding: ModelBinding) => boolean;
export type RoleLibrary = {
  revision: number;
  roles: Role[];
  tools: typeof toolDefinitions[number][];
  runtime: { enabled: false; mode: 'metadata-only' };
};

const BUILTIN_DATE = '2026-01-01T00:00:00.000Z';
const commonLimits = { maxSteps: 12, maxToolCalls: 20, deadlineMs: 120_000, maxCost: 10 };
const builtinDefinitions: Array<RoleDefinition & { id: string }> = [
  { id: 'scriptwriter', name: 'Scriptwriter', category: 'media', description: 'Creates structured scripts from an approved creative brief.',
    systemPrompt: 'Turn the approved creative brief into a coherent, audience-aware script. Preserve requested tone and duration. Do not claim to create media assets or contact external services.',
    inputContract: 'Creative brief, intended audience, tone and target duration.', outputContract: 'A structured script with stable scene and dialogue identifiers, speaker labels and timing estimates.',
    tools: ['context.search', 'assets.read'], modelSelection: { kind: 'inherit' }, limits: { ...commonLimits, maxSteps: 12, maxToolCalls: 12 } },
  { id: 'storyboard-director', name: 'Storyboard director', category: 'media', description: 'Turns an approved script into a shot-by-shot storyboard plan.',
    systemPrompt: 'Translate the approved script into clear, ordered shots. Describe composition, camera movement, duration and character continuity. Tool declarations are metadata only.',
    inputContract: 'Approved script, scene references and available project assets.', outputContract: 'A storyboard with stable shot IDs, visual descriptions, camera notes and duration allocation.',
    tools: ['assets.read', 'context.search', 'images.generate'], modelSelection: { kind: 'inherit' }, limits: { ...commonLimits, maxSteps: 16, maxToolCalls: 20 } },
  { id: 'continuity-reviewer', name: 'Character continuity reviewer', category: 'media', description: 'Finds visual and narrative continuity issues in selected shots.',
    systemPrompt: 'Compare only the supplied references and shots. Tie each finding to a shot ID and describe a bounded correction. Do not publish, edit or render assets.',
    inputContract: 'Character references, scene notes and selected storyboard shots.', outputContract: 'Findings with severity, affected shot IDs and bounded correction requests.',
    tools: ['assets.read', 'context.search'], modelSelection: { kind: 'inherit' }, limits: { ...commonLimits, maxSteps: 8, maxToolCalls: 10 } },
  { id: 'editor', name: 'Editor', category: 'media', description: 'Plans edit timing and checks supplied export requirements.',
    systemPrompt: 'Organize supplied approved media into a clear timeline and report export checks. Do not render or publish; tool declarations do not execute.',
    inputContract: 'Approved clips, dialogue timing, audio references and delivery requirements.', outputContract: 'Timeline instructions, timing checks and a list of unresolved export requirements.',
    tools: ['assets.read', 'media.render'], modelSelection: { kind: 'inherit' }, limits: { ...commonLimits, maxSteps: 10, maxToolCalls: 12 } },
  { id: 'architect', name: 'Architect', category: 'engineering', description: 'Produces technical plans and interface contracts from requirements.',
    systemPrompt: 'Analyze requirements and repository context. State assumptions, interfaces, failure behavior and risks. Do not edit or execute code.',
    inputContract: 'Product requirements and approved repository metadata.', outputContract: 'A technical plan with components, API contracts, data model and failure cases.',
    tools: ['context.search', 'code.read'], modelSelection: { kind: 'inherit' }, limits: { ...commonLimits, maxSteps: 10, maxToolCalls: 12 } },
  { id: 'developer', name: 'Developer', category: 'engineering', description: 'Plans bounded implementation work; code execution is unavailable in this milestone.',
    systemPrompt: 'Use approved technical plans to describe an implementation approach and verification steps. This role is a metadata template only; no repository sandbox or commands are available.',
    inputContract: 'Approved plan, explicit task scope and relevant repository context.', outputContract: 'A proposed patch outline and deterministic verification checklist; no code execution claim.',
    tools: ['context.search', 'code.read', 'code.edit', 'code.test'], modelSelection: { kind: 'inherit' }, limits: { ...commonLimits, maxSteps: 10, maxToolCalls: 16 } },
  { id: 'code-reviewer', name: 'Code reviewer', category: 'engineering', description: 'Reviews supplied patches and test evidence for concrete risks.',
    systemPrompt: 'Review only supplied code and evidence. Report actionable findings tied to files or behaviors. Do not change code, merge or deploy.',
    inputContract: 'Patch, policy requirements and test output.', outputContract: 'Findings with severity, evidence and review verdict; distinguish verified evidence from assertions.',
    tools: ['context.search', 'code.read', 'code.test'], modelSelection: { kind: 'inherit' }, limits: { ...commonLimits, maxSteps: 10, maxToolCalls: 12 } },
];

export const builtInRoleRecords: RoleRecord[] = builtinDefinitions.map(({ id, ...definition }) => ({
  ...definition, id, revision: 1, builtIn: true, lifecycle: 'published', createdAt: BUILTIN_DATE, updatedAt: BUILTIN_DATE,
}));

export function modelStatus(role: RoleRecord, resolveBinding: ModelStatusResolver): Role['modelStatus'] {
  if (role.modelSelection.kind === 'inherit') return 'inherit';
  return resolveBinding(role.modelSelection.binding) ? 'configured' : 'unavailable';
}

export class RoleStore {
  private state: RoleHistorySnapshot = { schemaVersion: 1, revision: 0, roleHistory: structuredClone(builtInRoleRecords) };
  private tail: Promise<unknown> = Promise.resolve();
  private fault: unknown;
  private constructor(private readonly path: string) {}

  static async open(directory: string): Promise<RoleStore> {
    const store = new RoleStore(join(directory, 'roles.json'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let contents: string;
    try { contents = await readFile(store.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store; throw error; }
    store.state = persistedSchema.parse(JSON.parse(contents));
    return store;
  }

  assertAvailable(): void {
    if (this.fault) throw new ApiError(503, 'ROLE_STORAGE_UNAVAILABLE', 'Role storage is unavailable. Inspect local storage and restart the API.');
  }

  read(resolveBinding: ModelStatusResolver): RoleLibrary {
    this.assertAvailable();
    const latest = new Map<string, RoleRecord>();
    for (const role of this.state.roleHistory) {
      if (!latest.has(role.id) || latest.get(role.id)!.revision < role.revision) latest.set(role.id, role);
    }
    return {
      revision: this.state.revision,
      roles: [...latest.values()].map((role) => ({ ...structuredClone(role), modelStatus: modelStatus(role, resolveBinding) })),
      tools: structuredClone(toolDefinitions) as unknown as RoleLibrary['tools'],
      runtime: { enabled: false, mode: 'metadata-only' },
    };
  }

  revisions(id: string, resolveBinding: ModelStatusResolver): Role[] {
    this.assertAvailable();
    const revisions = this.state.roleHistory.filter((role) => role.id === id).sort((left, right) => left.revision - right.revision);
    if (revisions.length === 0) throw new ApiError(404, 'ROLE_NOT_FOUND', 'Role not found.');
    return revisions.map((role) => ({ ...structuredClone(role), modelStatus: modelStatus(role, resolveBinding) }));
  }

  create(revision: number, definition: RoleDefinition, resolveBinding: ModelStatusResolver): Promise<{ revision: number; role: Role }> {
    return this.transact(revision, (state) => {
      if (this.customIds(state).size >= 64) throw new ApiError(409, 'ROLE_LIMIT_REACHED', 'At most 64 custom roles are supported.');
      validateModelSelection(definition.modelSelection, resolveBinding);
      const now = new Date().toISOString();
      const role: RoleRecord = { ...structuredClone(definition), id: randomUUID(), revision: 1, builtIn: false, lifecycle: 'draft', createdAt: now, updatedAt: now };
      state.roleHistory.push(role); state.revision++;
      return { revision: state.revision, role: { ...role, modelStatus: modelStatus(role, resolveBinding) } };
    });
  }

  edit(id: string, revision: number, definition: RoleDefinition, resolveBinding: ModelStatusResolver): Promise<{ revision: number; role: Role }> {
    return this.transact(revision, (state) => {
      const current = latestRole(state, id);
      if (!current) throw new ApiError(404, 'ROLE_NOT_FOUND', 'Role not found.');
      if (current.builtIn) throw new ApiError(409, 'BUILTIN_ROLE_READ_ONLY', 'Built-in roles cannot be edited. Copy this role to create a custom draft.');
      if (current.lifecycle === 'archived') throw new ApiError(409, 'ROLE_ARCHIVED', 'Archived roles cannot be edited.');
      validateModelSelection(definition.modelSelection, resolveBinding);
      const role: RoleRecord = { ...structuredClone(definition), id, revision: current.revision + 1, builtIn: false, lifecycle: 'draft', createdAt: current.createdAt, updatedAt: laterTimestamp(current.updatedAt) };
      state.roleHistory.push(role); state.revision++;
      return { revision: state.revision, role: { ...role, modelStatus: modelStatus(role, resolveBinding) } };
    });
  }

  archive(id: string, revision: number, resolveBinding: ModelStatusResolver): Promise<{ revision: number; role: Role }> {
    return this.transact(revision, (state) => {
      const current = latestRole(state, id);
      if (!current) throw new ApiError(404, 'ROLE_NOT_FOUND', 'Role not found.');
      if (current.builtIn) throw new ApiError(409, 'BUILTIN_ROLE_READ_ONLY', 'Built-in roles cannot be archived.');
      if (current.lifecycle === 'archived') return { revision: state.revision, role: { ...current, modelStatus: modelStatus(current, resolveBinding) } };
      const role: RoleRecord = { ...structuredClone(current), revision: current.revision + 1, lifecycle: 'archived', updatedAt: laterTimestamp(current.updatedAt) };
      state.roleHistory.push(role); state.revision++;
      return { revision: state.revision, role: { ...role, modelStatus: modelStatus(role, resolveBinding) } };
    });
  }

  private transact<T>(revision: number, change: (state: RoleHistorySnapshot) => T): Promise<T> {
    const task = this.tail.then(async () => {
      this.assertAvailable();
      if (revision !== this.state.revision) throw new ApiError(409, 'ROLE_LIBRARY_CONFLICT', 'The role library changed. Reload before saving.');
      const next = structuredClone(this.state);
      const result = change(next);
      persistedSchema.parse(next);
      try { await atomicWrite(this.path, JSON.stringify(next)); }
      catch (error) { this.fault = error; throw error; }
      this.state = next;
      return structuredClone(result);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  private customIds(state: RoleHistorySnapshot): Set<string> {
    return new Set(state.roleHistory.filter((role) => !role.builtIn).map((role) => role.id));
  }

  async close(): Promise<void> { await this.tail; }
}

function latestRole(state: RoleHistorySnapshot, id: string): RoleRecord | undefined {
  return state.roleHistory.filter((role) => role.id === id).reduce<RoleRecord | undefined>((latest, role) => !latest || role.revision > latest.revision ? role : latest, undefined);
}

function validateModelSelection(selection: RoleDefinition['modelSelection'], resolveBinding: ModelStatusResolver): void {
  if (selection.kind === 'binding' && !resolveBinding(selection.binding)) {
    throw new ApiError(400, 'INVALID_MODEL_BINDING', 'Model binding must resolve to an enabled Settings v2 account and a declared text or code model.');
  }
}

function laterTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function matchesBuiltIn(role: RoleRecord): boolean {
  const baseline = builtInRoleRecords.find((item) => item.id === role.id);
  return Boolean(baseline && JSON.stringify(role) === JSON.stringify(baseline));
}
