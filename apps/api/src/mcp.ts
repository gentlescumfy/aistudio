import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { GovernanceGateway } from './governance.js';
import type { StoreSet } from './store-pool.js';
import { ApiError } from './domain.js';

export const mcpGatewayPlugin: FastifyPluginAsync = async (app) => {
  app.post('/api/mcp/execute', async (request, reply) => {
    const project = (request as unknown as { project: StoreSet }).project;
    const gateway = new GovernanceGateway(project.file.directory);
    await gateway.load();

    const input = z.strictObject({
      runId: z.string().uuid(),
      nodeId: z.string(),
      roleId: z.string(),
      toolName: z.string(),
      parameters: z.record(z.string(), z.unknown()),
      currentStepCount: z.number().int().nonnegative(),
      currentToolCallCount: z.number().int().nonnegative(),
      currentCost: z.number().nonnegative(),
      estimatedCost: z.number().nonnegative().default(0),
    }).parse(request.body);
    
    // Resolve the role to get its limits
    const roleSnapshot = project.roles.revisions(input.roleId, () => true).at(-1);
    if (!roleSnapshot) {
      throw new ApiError(404, 'ROLE_NOT_FOUND', 'The specified role was not found.');
    }

    const attempt = await gateway.evaluateToolCall(
      roleSnapshot,
      input.runId,
      input.nodeId,
      input.toolName,
      input.parameters,
      input.currentStepCount,
      input.currentToolCallCount,
      input.currentCost,
      input.estimatedCost
    );

    if (attempt.status === 'rejected') {
      return reply.code(403).send({ error: attempt.errorMessage, attempt });
    }

    // Here we would proxy to the actual MCP server.
    // For now, since this is the governance integration step, we just return the approved attempt
    // which signifies the tool execution was authorized.
    
    // TODO: Forward to real MCP server
    
    attempt.status = 'succeeded';
    attempt.updatedAt = new Date().toISOString();

    return { result: 'Authorized and mocked execution', attempt };
  });

  app.get('/api/mcp/journal/:runId', async (request) => {
    const project = (request as unknown as { project: StoreSet }).project;
    const gateway = new GovernanceGateway(project.file.directory);
    await gateway.load();
    const runId = z.string().uuid().parse((request.params as any).runId);
    return { attempts: gateway.getJournal(runId) };
  });
};
