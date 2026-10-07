import { z } from 'zod';
import { workflowRecordSchema } from './workflow-contract.js';

export const inputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(2000),
  count: z.number().int().min(1).max(8),
});
export const createSchema = z.strictObject({
  templateId: z.string().min(1).max(100),
  inputs: inputSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  workflowRevision: z.number().int().positive().optional(),
});
const nodeSchema = z.strictObject({
  id: z.string(), name: z.string(), kind: z.enum(['prompt', 'image', 'export']),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(), error: z.string().optional(),
  config: z.union([
    z.strictObject({ template: z.string().max(6000), roleRef: z.unknown().nullable() }),
    z.strictObject({ width: z.number().int().min(512).max(2048), height: z.number().int().min(512).max(2048), count: z.number().int().min(1).max(8).nullable() }),
    z.strictObject({}),
  ]).optional(),
  dependsOn: z.array(z.string()).optional(), outputPrompt: z.string().max(16_000).optional(),
});
export const assetSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{24}$/), runId: z.uuid(), nodeId: z.string(),
  name: z.string(), mimeType: z.literal('image/svg+xml'), url: z.string(),
  width: z.number().int().positive(), height: z.number().int().positive(), mode: z.literal('mock'),
});
export const runSchema = z.strictObject({
  id: z.uuid(), templateId: z.string().min(1).max(100),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  inputs: inputSchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  mode: z.literal('mock'), nodes: z.array(nodeSchema), assets: z.array(assetSchema),
  estimatedCost: z.literal(0), actualCost: z.literal(0), error: z.string().optional(),
  workflowSnapshot: workflowRecordSchema.optional(), expectedAssetCount: z.number().int().nonnegative().optional(),
});
export const databaseSchema = z.strictObject({
  version: z.literal(2), runs: z.array(runSchema),
  submissions: z.array(z.strictObject({
    key: z.string(), fingerprint: z.string(), runId: z.uuid(),
  })),
});
export const legacyDatabaseSchema = z.strictObject({ version: z.literal(1), runs: z.array(runSchema), submissions: z.array(z.strictObject({ key: z.string(), fingerprint: z.string(), runId: z.uuid() })) });
export type Inputs = z.infer<typeof inputSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunNode = Run['nodes'][number];
export type Asset = z.infer<typeof assetSchema>;
export type Database = z.infer<typeof databaseSchema>;
export interface Template {
  id: string; name: string; description: string;
  category: 'image' | 'video' | 'coding'; enabled: boolean;
  nodes: { id: string; name: string; kind: string }[];
  workflowRevision?: number; source?: 'workflow';
}
export const templates: Template[] = [
  {
    id: 'brand-assets', name: 'Brand asset kit', category: 'image', enabled: true,
    description: 'Local mock demonstration: deterministic SVG brand concepts, not AI generation. Cost: 0.',
    nodes: [
      { id: 'brief', name: 'Prepare brand brief', kind: 'prompt' },
      { id: 'generate', name: 'Render mock concepts', kind: 'image' },
      { id: 'export', name: 'Prepare downloadable assets', kind: 'export' },
    ],
  },
  { id: 'video-story', name: 'Video story', category: 'video', enabled: false,
    description: 'Coming soon. Video generation is unavailable.', nodes: [] },
  { id: 'coding-assistant', name: 'Coding assistant', category: 'coding', enabled: false,
    description: 'Coming soon. Code and shell execution are unavailable.', nodes: [] },
];
export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export function findRun(db: Database, id: string): Run {
  const run = db.runs.find((item) => item.id === id);
  if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found.');
  return run;
}
export function touch(run: Run): void { run.updatedAt = new Date().toISOString(); }
