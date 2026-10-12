import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { GovernanceGateway } from './governance.js';
import type { StoreSet } from './store-pool.js';
import { ApiError } from './domain.js';
import { mcpExecuteRequestSchema } from './mcp-contract.js';

export const mcpGatewayPlugin: FastifyPluginAsync = async (app) => {
  app.post('/api/mcp/execute', async (request, reply) => {
    const project = (request as unknown as { project: StoreSet }).project;
    const gateway = new GovernanceGateway(project.file.directory);
    await gateway.load();

    const input = mcpExecuteRequestSchema.parse(request.body);
    
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
    
    const completed = await gateway.completeToolCall(attempt.id, 'succeeded');

    return { result: 'Authorized and mocked execution', attempt: completed };
  });

  app.get('/api/mcp/journal/:runId', async (request) => {
    const project = (request as unknown as { project: StoreSet }).project;
    const gateway = new GovernanceGateway(project.file.directory);
    await gateway.load();
    const runId = z.string().uuid().parse((request.params as any).runId);
    return { attempts: gateway.getJournal(runId) };
  });
};
