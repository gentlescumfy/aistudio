import { z } from 'zod';

export const mcpExecuteRequestSchema = z.strictObject({
  runId: z.string().uuid(),
  nodeId: z.string(),
  roleId: z.string(),
  toolName: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  currentStepCount: z.number().int().nonnegative(),
  currentToolCallCount: z.number().int().nonnegative(),
  currentCost: z.number().nonnegative(),
  estimatedCost: z.number().nonnegative().default(0),
});
