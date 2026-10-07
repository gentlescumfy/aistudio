import { z } from 'zod';

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const roleRefSchema = z.strictObject({ id: z.union([slugSchema, z.uuid()]), revision: z.number().int().positive() });
const positionSchema = z.strictObject({ x: z.number().finite().min(-10_000).max(10_000), y: z.number().finite().min(-10_000).max(10_000) });
const baseSchema = z.strictObject({ id: slugSchema, name: z.string().trim().min(1).max(80), position: positionSchema });
export const workflowNodeSchema = z.discriminatedUnion('kind', [
  baseSchema.extend({ kind: z.literal('prompt'), config: z.strictObject({ template: z.string().max(6000), roleRef: roleRefSchema.nullable() }) }),
  baseSchema.extend({ kind: z.literal('image'), config: z.strictObject({ width: z.number().int().min(512).max(2048), height: z.number().int().min(512).max(2048), count: z.number().int().min(1).max(8).nullable() }) }),
  baseSchema.extend({ kind: z.literal('export'), config: z.strictObject({}) }),
]);
export const workflowEdgeSchema = z.strictObject({ id: slugSchema, source: slugSchema, target: slugSchema });
export const workflowDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1000),
  nodes: z.array(workflowNodeSchema).max(20),
  edges: z.array(workflowEdgeSchema).max(40),
}).superRefine((definition, context) => {
  for (const [field, items] of [['nodes', definition.nodes], ['edges', definition.edges]] as const) {
    const ids = new Set<string>();
    items.forEach((item, index) => {
      if (ids.has(item.id)) context.addIssue({ code: 'custom', path: [field, index, 'id'], message: `${field} IDs must be unique.` });
      ids.add(item.id);
    });
  }
});

const snapshotRoleSchema = z.strictObject({
  id: z.string().min(1).max(64), revision: z.number().int().positive(), builtIn: z.boolean(),
  name: z.string().trim().min(1).max(80), category: z.enum(['media', 'engineering', 'operations', 'custom']),
  description: z.string().trim().min(1).max(1000), systemPrompt: z.string().trim().min(1).max(6000),
  inputContract: z.string().trim().min(1).max(4000), outputContract: z.string().trim().min(1).max(4000),
  tools: z.array(z.enum(['assets.read', 'context.search', 'images.generate', 'media.render', 'code.read', 'code.edit', 'code.test'])),
  modelSelection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('inherit') }),
    z.strictObject({ kind: z.literal('binding'), binding: z.strictObject({ providerId: slugSchema, accountId: slugSchema, modelId: slugSchema }) }),
  ]),
  limits: z.strictObject({ maxSteps: z.number().int().min(1).max(100), maxToolCalls: z.number().int().min(0).max(1000), deadlineMs: z.number().int().min(1000).max(3_600_000), maxCost: z.number().min(0).max(1000) }),
  lifecycle: z.enum(['draft', 'published', 'archived']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  modelStatus: z.enum(['inherit', 'configured', 'unavailable']),
});
const roleSnapshotSchema = z.strictObject({ nodeId: slugSchema, role: snapshotRoleSchema });
export const workflowRecordSchema = workflowDefinitionSchema.extend({
  id: z.uuid(), revision: z.number().int().positive(), lifecycle: z.enum(['draft', 'published', 'archived']),
  publishedRevision: z.number().int().positive().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  roleSnapshots: z.array(roleSnapshotSchema),
});
export const workflowLibrarySchema = z.strictObject({
  revision: z.number().int().nonnegative(), workflows: z.array(workflowRecordSchema), starterDefinition: workflowDefinitionSchema,
  runtime: z.strictObject({ mode: z.literal('mock'), executableKinds: z.tuple([z.literal('prompt'), z.literal('image'), z.literal('export')]), agentExecutionEnabled: z.literal(false) }),
});
export const workflowMutationSchema = z.strictObject({ revision: z.number().int().nonnegative(), workflow: workflowDefinitionSchema });
export const workflowPublishRequestSchema = z.strictObject({ revision: z.number().int().nonnegative() });
export const workflowArchiveRequestSchema = workflowPublishRequestSchema;
export const workflowValidateRequestSchema = z.strictObject({ workflow: workflowDefinitionSchema });
export const workflowTemplateRevisionSchema = z.number().int().positive().optional();

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type Workflow = z.infer<typeof workflowRecordSchema>;
export type WorkflowValidation = { valid: boolean; issues: GraphIssue[]; warnings: string[] };
export type GraphIssue = { code: string; message: string; nodeId?: string; edgeId?: string };
export type WorkflowTemplate = {
  id: string; name: string; description: string; category: 'image'; enabled: true;
  nodes: { id: string; name: string; kind: string }[]; workflowRevision: number; source: 'workflow';
};

export const starterDefinition: WorkflowDefinition = {
  name: 'Brand concept workflow',
  description: 'A local mock workflow that prepares a brief, renders SVG concepts and validates the export.',
  nodes: [
    { id: 'brief', name: 'Prepare brief', position: { x: 80, y: 160 }, kind: 'prompt', config: { template: 'Create a visual brand concept for: {{prompt}}. Requested count: {{count}}.', roleRef: null } },
    { id: 'generate', name: 'Generate concepts', position: { x: 360, y: 160 }, kind: 'image', config: { width: 1024, height: 1024, count: null } },
    { id: 'export', name: 'Export assets', position: { x: 640, y: 160 }, kind: 'export', config: {} },
  ],
  edges: [
    { id: 'brief-generate', source: 'brief', target: 'generate' },
    { id: 'generate-export', source: 'generate', target: 'export' },
  ],
};
