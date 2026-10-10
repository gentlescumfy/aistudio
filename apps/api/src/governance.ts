import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from './store.js';
import type { RoleRecord } from './roles.js';

export type ToolAttemptStatus = 'pending' | 'approved' | 'rejected' | 'succeeded' | 'failed';

export const toolAttemptSchema = z.strictObject({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  nodeId: z.string(),
  toolName: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'approved', 'rejected', 'succeeded', 'failed']),
  cost: z.number().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  errorMessage: z.string().optional(),
});

export type ToolAttempt = z.infer<typeof toolAttemptSchema>;

/**
 * 治理网关（Governance Gateway）
 * 借鉴 AgentsRoom 核心治理架构：在模型与工具执行前建立强制安全守卫与预算围栏。
 * - 拦截未授权工具调用与越界参数
 * - 强制执行 role.limits (maxSteps, maxToolCalls, maxCost)
 * - 拒绝文案一律以明确的行动指令结尾（Actionable Refusal Messages）
 * - 记录可审计的持久化 Attempt Journal
 */
export class GovernanceGateway {
  private attemptJournal: ToolAttempt[] = [];

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    try {
      const contents = await readFile(join(this.directory, 'mcp-journal.json'), 'utf8');
      this.attemptJournal = z.array(toolAttemptSchema).parse(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.attemptJournal = [];
    }
  }

  private async save(): Promise<void> {
    await atomicWrite(join(this.directory, 'mcp-journal.json'), JSON.stringify(this.attemptJournal));
  }

  /**
   * 智能体节点前置守卫校验（在发起外部模型调用前拦截）
   */
  async evaluateAgentExecution(
    role: RoleRecord,
    runId: string,
    nodeId: string,
    currentStepCount: number,
    currentCost: number,
    estimatedCost: number = 0,
  ): Promise<{ approved: boolean; error?: string }> {
    await this.load();

    if (currentStepCount > role.limits.maxSteps) {
      const error = `治理网关拦截：已达到该角色执行步骤上限 (当前步骤=${currentStepCount} > 上限=${role.limits.maxSteps})。请拆解业务流程或在角色设置中调高 maxSteps 配额；请勿重复重试当前节点。`;
      return { approved: false, error };
    }

    if (currentCost + estimatedCost > role.limits.maxCost) {
      const error = `治理网关拦截：超出该角色预算法定上限 (已用 $${currentCost.toFixed(4)} + 本次预计 $${estimatedCost.toFixed(4)} > 上限 $${role.limits.maxCost})。请调整角色预算上限或精简提示词；请勿盲目重试。`;
      return { approved: false, error };
    }

    return { approved: true };
  }

  /**
   * 工具调用守卫校验（在 MCP 工具执行前拦截）
   */
  async evaluateToolCall(
    role: RoleRecord,
    runId: string,
    nodeId: string,
    toolName: string,
    parameters: Record<string, unknown>,
    currentStepCount: number,
    currentToolCallCount: number,
    currentCost: number,
    estimatedCost: number = 0,
  ): Promise<ToolAttempt> {
    await this.load();

    const attempt: ToolAttempt = {
      id: randomUUID(),
      runId,
      nodeId,
      toolName,
      parameters,
      status: 'pending',
      cost: estimatedCost,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.attemptJournal.push(attempt);

    // 1. 步数、工具调用数及预算上限检查
    if (currentStepCount >= role.limits.maxSteps) {
      return await this.reject(
        attempt,
        `治理网关拦截：已达到该角色执行步骤上限 (当前步骤=${currentStepCount} >= 上限=${role.limits.maxSteps})。请停止执行，拆解任务或在角色配置中调高 maxSteps；切勿重复重试当前步骤。`,
      );
    }
    if (currentToolCallCount >= role.limits.maxToolCalls) {
      return await this.reject(
        attempt,
        `治理网关拦截：已达到该角色工具调用上限 (调用数=${currentToolCallCount} >= 上限=${role.limits.maxToolCalls})。请停止调用工具，直接基于已有结果整理产出；禁止发起新的工具调用。`,
      );
    }
    if (currentCost + estimatedCost > role.limits.maxCost) {
      return await this.reject(
        attempt,
        `治理网关拦截：超出该角色预算法定上限 (已用 $${currentCost.toFixed(4)} + 本次预计 $${estimatedCost.toFixed(4)} > 上限 $${role.limits.maxCost})。请在角色配置中增加预算配额；切勿重试。`,
      );
    }

    // 2. 角色工具权限白名单检查
    if (!role.tools.includes(toolName as any)) {
      return await this.reject(
        attempt,
        `治理网关拦截：角色未授权使用工具 '${toolName}'。请检查角色授权工具列表并在角色定义中声明权限；请勿尝试伪造或绕过工具调用。`,
      );
    }

    // 3. 敏感参数边界检查（如远程主机白名单）
    if (toolName === 'ssh' || toolName === 'ssh.execute') {
      const host = typeof parameters['host'] === 'string' ? parameters['host'] : undefined;
      const allowedHosts = ['127.0.0.1', 'localhost', 'github.com'];
      if (host && !allowedHosts.includes(host)) {
        return await this.reject(
          attempt,
          `治理网关拦截：目标主机 '${host}' 未在受信任白名单中。请检查参数或添加受信任主机；禁止连接非受信任目标。`,
        );
      }
    }

    // 通过全部校验后标记为 approved 并落盘
    attempt.status = 'approved';
    attempt.updatedAt = new Date().toISOString();
    await this.save();
    return attempt;
  }

  private async reject(attempt: ToolAttempt, reason: string): Promise<ToolAttempt> {
    attempt.status = 'rejected';
    attempt.errorMessage = reason;
    attempt.updatedAt = new Date().toISOString();
    await this.save();
    return attempt;
  }

  getJournal(runId: string): ToolAttempt[] {
    return this.attemptJournal.filter((a) => a.runId === runId);
  }
}
