import { z } from 'zod';

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const roleRefSchema = z.strictObject({ id: z.union([slugSchema, z.uuid()]), revision: z.number().int().positive() });
const positionSchema = z.strictObject({ x: z.number().finite().min(-10_000).max(10_000), y: z.number().finite().min(-10_000).max(10_000) });
const baseSchema = z.strictObject({ id: slugSchema, name: z.string().trim().min(1).max(80), position: positionSchema });
export const workflowNodeSchema = z.discriminatedUnion('kind', [
  baseSchema.extend({ kind: z.literal('prompt'), config: z.strictObject({ template: z.string().max(6000), roleRef: roleRefSchema.nullable(), executionMode: z.enum(['template', 'agent']).optional() }) }),
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
  runtime: z.strictObject({ mode: z.literal('mixed'), executableKinds: z.tuple([z.literal('prompt'), z.literal('image'), z.literal('export')]), agentExecutionEnabled: z.literal(true) }),
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
  nodes: { id: string; name: string; kind: string }[]; workflowRevision: number; source: 'workflow'; agentNodeCount: number;
};

export const starterDefinition: WorkflowDefinition = {
  name: '咖啡新品上市视觉全流程',
  description: '完整链路：上市创意简报 → 3 镜分镜 → 连续性审查 → 主视觉生成 → 素材交付。示例输入：云南小批量浅烘焙咖啡，150 g 整豆，花香与柑橘尾韵；受众为手冲爱好者；视觉温暖、安静。不得虚构认证或未提供的产品事实。',
  nodes: [
    { id: 'campaign-brief', name: '提炼上市创意简报', position: { x: 80, y: 160 }, kind: 'prompt', config: { template: '为以下咖啡新品准备上市创意简报。给出目标客群、核心卖点、品牌语气、一句主标语和视觉方向；没有提供的数据标为未知，不要编造。\n产品资料：{{prompt}}\n本次需要交付 {{count}} 张主视觉。', roleRef: { id: 'scriptwriter', revision: 1 }, executionMode: 'agent' } },
    { id: 'shot-plan', name: '编排产品分镜', position: { x: 380, y: 160 }, kind: 'prompt', config: { template: '根据上游创意简报设计 3 个可用于同一上市活动的产品镜头。每个镜头写明目的、主体、构图、光线、背景、主色和一条完整的图像提示词；产品包装和品牌色必须保持一致。\n创意简报：{{prompt}}', roleRef: { id: 'storyboard-director', revision: 1 }, executionMode: 'agent' } },
    { id: 'continuity-review', name: '审查并修正视觉提示词', position: { x: 680, y: 160 }, kind: 'prompt', config: { template: '检查上游分镜中的产品外观、包装、品牌色、场景和事实是否一致。修正冲突后，只输出一条完整、可直接用于生成主视觉的最终提示词；不要加入未提供的产品规格或文字。\n分镜方案：{{prompt}}', roleRef: { id: 'continuity-reviewer', revision: 1 }, executionMode: 'agent' } },
    { id: 'hero-image', name: '生成上市主视觉', position: { x: 980, y: 160 }, kind: 'image', config: { width: 1024, height: 1024, count: 1 } },
    { id: 'delivery', name: '交付主视觉素材', position: { x: 1280, y: 160 }, kind: 'export', config: {} },
  ],
  edges: [
    { id: 'brief-storyboard', source: 'campaign-brief', target: 'shot-plan' },
    { id: 'storyboard-review', source: 'shot-plan', target: 'continuity-review' },
    { id: 'review-image', source: 'continuity-review', target: 'hero-image' },
    { id: 'image-delivery', source: 'hero-image', target: 'delivery' },
  ],
};
