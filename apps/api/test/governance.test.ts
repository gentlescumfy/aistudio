import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GovernanceGateway } from '../src/governance.js';
import type { RoleRecord } from '../src/roles.js';

function createMockRole(overrides?: Partial<RoleRecord['limits']>, tools: string[] = ['assets.read', 'context.search']): RoleRecord {
  return {
    id: 'test-architect',
    revision: 1,
    builtIn: false,
    lifecycle: 'published',
    name: 'Test Architect',
    category: 'engineering',
    description: 'System design role',
    systemPrompt: 'You are an architect.',
    inputContract: 'Specification',
    outputContract: 'Architecture Decision',
    tools: tools as any,
    modelSelection: { kind: 'inherit' },
    limits: {
      maxSteps: 3,
      maxToolCalls: 5,
      deadlineMs: 60000,
      maxCost: 1.0,
      ...overrides,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('GovernanceGateway blocks agent execution when maxSteps exceeded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const gateway = new GovernanceGateway(dir);
  const role = createMockRole({ maxSteps: 2 });
  const runId = randomUUID();

  // Within steps limit (step 1 and 2)
  const okResult = await gateway.evaluateAgentExecution(role, runId, 'node-1', 2, 0);
  assert.equal(okResult.approved, true);

  // Exceeding steps limit (step 3 > maxSteps 2)
  const blockedResult = await gateway.evaluateAgentExecution(role, runId, 'node-1', 3, 0);
  assert.equal(blockedResult.approved, false);
  assert.match(blockedResult.error!, /治理网关拦截：已达到该角色执行步骤上限/);
  assert.match(blockedResult.error!, /请勿重复重试当前节点/);
});

test('GovernanceGateway blocks agent execution when maxCost exceeded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const gateway = new GovernanceGateway(dir);
  const role = createMockRole({ maxCost: 0.5 });
  const runId = randomUUID();

  // Exceeding cost limit
  const blockedResult = await gateway.evaluateAgentExecution(role, runId, 'node-1', 1, 0.45, 0.1);
  assert.equal(blockedResult.approved, false);
  assert.match(blockedResult.error!, /超出该角色预算法定上限/);
  assert.match(blockedResult.error!, /请勿盲目重试/);
});

test('GovernanceGateway enforces tool permissions and parameters with actionable messages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const gateway = new GovernanceGateway(dir);
  const role = createMockRole({ maxToolCalls: 2 }, ['assets.read', 'context.search']);
  const runId = randomUUID();

  // 1. Tool call limit exceeded
  const attemptLimit = await gateway.evaluateToolCall(
    role,
    runId,
    'node-1',
    'assets.read',
    {},
    1,
    2, // currentToolCallCount >= maxToolCalls 2
    0.1,
    0,
  );
  assert.equal(attemptLimit.status, 'rejected');
  assert.match(attemptLimit.errorMessage!, /已达到该角色工具调用上限/);
  assert.match(attemptLimit.errorMessage!, /禁止发起新的工具调用/);

  // 2. Unauthorized tool
  const attemptUnauthorized = await gateway.evaluateToolCall(
    role,
    runId,
    'node-1',
    'images.generate', // not in role.tools
    {},
    1,
    0,
    0.1,
    0,
  );
  assert.equal(attemptUnauthorized.status, 'rejected');
  assert.match(attemptUnauthorized.errorMessage!, /角色未授权使用工具 'images.generate'/);
  assert.match(attemptUnauthorized.errorMessage!, /请勿尝试伪造或绕过工具调用/);

  // 3. Authorized tool call succeeds and persists to journal
  const attemptSuccess = await gateway.evaluateToolCall(
    role,
    runId,
    'node-1',
    'assets.read',
    { assetId: 'abc' },
    1,
    0,
    0.1,
    0,
  );
  assert.equal(attemptSuccess.status, 'approved');

  // Verify journal retrieval
  const journal = gateway.getJournal(runId);
  assert.equal(journal.length, 3);
  assert.equal(journal[2]!.toolName, 'assets.read');
  assert.equal(journal[2]!.status, 'approved');
});

test('GovernanceGateway persists completion and serializes concurrent journal updates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gov-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const role = createMockRole();
  const runId = randomUUID();
  const first = new GovernanceGateway(dir);
  const second = new GovernanceGateway(dir);
  const attempts = await Promise.all([
    first.evaluateToolCall(role, runId, 'node-1', 'assets.read', { assetId: 'one' }, 1, 0, 0),
    second.evaluateToolCall(role, runId, 'node-1', 'context.search', { query: 'two' }, 1, 0, 0),
  ]);
  assert.equal(new Set(attempts.map((attempt) => attempt.id)).size, 2);
  await first.completeToolCall(attempts[0]!.id, 'succeeded');

  const reloaded = new GovernanceGateway(dir);
  await reloaded.load();
  const journal = reloaded.getJournal(runId);
  assert.equal(journal.length, 2);
  assert.equal(journal.find((attempt) => attempt.id === attempts[0]!.id)?.status, 'succeeded');
  assert.equal(journal.find((attempt) => attempt.id === attempts[1]!.id)?.status, 'approved');
});
