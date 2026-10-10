import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createApp, type AppOptions } from '../src/app.js';
import { starterDefinition, type WorkflowDefinition } from '../src/workflow-contract.js';
import { compileWorkflowToLangflow } from '../src/langflow-compiler.js';
import { LangflowService } from '../src/langflow.js';
import { defaultLangflowConfig } from '../src/langflow-contract.js';

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('compileWorkflowToLangflow converts workflow starter definition to Langflow flow payload', () => {
  const compiled = compileWorkflowToLangflow(starterDefinition, { projectId: 'project-alpha' });

  assert.equal(compiled.name, starterDefinition.name);
  assert.equal(compiled.description, starterDefinition.description);
  assert.equal(compiled.is_component, false);
  assert.equal(compiled.folder_id, 'project-alpha');
  assert.equal(compiled.project_id, 'project-alpha');
  assert.deepEqual(compiled.data.viewport, { x: 0, y: 0, zoom: 1 });

  // 节点总数与顺序校验
  assert.equal(compiled.data.nodes.length, starterDefinition.nodes.length);
  assert.equal(compiled.data.edges.length, starterDefinition.edges.length);

  // 1. Agent Prompt 节点校验
  const agentNode = compiled.data.nodes.find((n) => n.id === 'campaign-brief')!;
  assert.ok(agentNode);
  assert.equal(agentNode.type, 'Agent');
  assert.equal(agentNode.data.type, 'Agent');
  assert.equal(agentNode.data.node.display_name, '提炼上市创意简报');
  assert.equal(agentNode.data.node.template.template.value, starterDefinition.nodes[0]!.config.template);
  assert.equal(agentNode.data.node.template.execution_mode.value, 'agent');
  assert.equal(agentNode.data.node.template.role_id.value, 'scriptwriter');
  assert.equal(agentNode.data.node.template.role_revision.value, 1);
  assert.equal(agentNode.position.x, 80);
  assert.equal(agentNode.position.y, 160);

  // 2. Image 节点校验
  const imageNode = compiled.data.nodes.find((n) => n.id === 'hero-image')!;
  assert.ok(imageNode);
  assert.equal(imageNode.type, 'ImageGenerator');
  assert.equal(imageNode.data.type, 'ImageGenerator');
  assert.equal(imageNode.data.node.display_name, '生成上市主视觉');
  assert.equal(imageNode.data.node.template.width.value, 1024);
  assert.equal(imageNode.data.node.template.height.value, 1024);
  assert.equal(imageNode.data.node.template.count.value, 1);
  assert.equal(imageNode.position.x, 980);
  assert.equal(imageNode.position.y, 160);

  // 3. Export 节点校验
  const exportNode = compiled.data.nodes.find((n) => n.id === 'delivery')!;
  assert.ok(exportNode);
  assert.equal(exportNode.type, 'ExportOutput');
  assert.equal(exportNode.data.type, 'ExportOutput');
  assert.equal(exportNode.data.node.display_name, '交付主视觉素材');
  assert.equal(exportNode.data.node.template.export_format.value, 'zip');
  assert.equal(exportNode.position.x, 1280);
  assert.equal(exportNode.position.y, 160);

  // 4. Edges 连线结构校验
  const edge1 = compiled.data.edges.find((e) => e.id === 'edge-brief-storyboard')!;
  assert.ok(edge1);
  assert.equal(edge1.source, 'campaign-brief');
  assert.equal(edge1.target, 'shot-plan');
  assert.equal(edge1.sourceHandle, 'campaign-brief-output');
  assert.equal(edge1.targetHandle, 'shot-plan-input');
});

test('compileWorkflowToLangflow supports template execution mode for prompt nodes', () => {
  const customWorkflow: WorkflowDefinition = {
    name: '模板测试',
    description: '纯模板工作流',
    nodes: [
      {
        id: 'tmpl-1',
        name: '普通模板',
        position: { x: 50, y: 50 },
        kind: 'prompt',
        config: { template: 'Hello {{name}}', roleRef: null, executionMode: 'template' },
      },
    ],
    edges: [],
  };

  const compiled = compileWorkflowToLangflow(customWorkflow);
  assert.equal(compiled.folder_id, null);
  assert.equal(compiled.project_id, null);
  const node = compiled.data.nodes[0]!;
  assert.equal(node.type, 'PromptTemplate');
  assert.equal(node.data.type, 'PromptTemplate');
  assert.equal(node.data.node.template.execution_mode.value, 'template');
  assert.equal(node.data.node.template.role_id.value, null);
  assert.equal(node.data.node.template.role_revision.value, null);
});

test('LangflowService.publishWorkflowToProject posts compiled flow to Langflow upstream', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-compiler-service-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  let postedBody: any = null;
  const mockFlowId = 'a1b2c3d4-e5f6-4a1b-9c2d-e3f4a5b6c7d8';

  const fetcher: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/api/v1/flows/')) {
      postedBody = JSON.parse(init?.body as string);
      return json({ id: mockFlowId, name: postedBody.name });
    }
    return json({ detail: 'not found' }, 404);
  }) as typeof fetch;

  const service = await LangflowService.open(directory, fetcher);
  t.after(async () => { await service.close(); });

  const result = await service.publishWorkflowToProject('proj-123', starterDefinition);
  assert.equal(result.flowId, mockFlowId);
  assert.ok(postedBody);
  assert.equal(postedBody.name, starterDefinition.name);
  assert.equal(postedBody.folder_id, 'proj-123');
  assert.equal(postedBody.data.nodes.length, starterDefinition.nodes.length);
});

test('POST /api/workflows/compile-langflow compiles definition without persisting or probing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-compiler-api-'));
  const app = await createApp({ dataDir: directory });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/workflows/compile-langflow',
    payload: { workflow: starterDefinition },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.flow);
  assert.equal(body.flow.name, starterDefinition.name);
  assert.equal(body.flow.data.nodes.length, 5);
  assert.equal(body.flow.data.edges.length, 4);
});

test('POST /api/workflows/:id/publish-langflow publishes existing workflow to Langflow', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'aistudio-publish-api-'));
  const postedBodies: any[] = [];
  const mockFlowId = 'f74234d2-ec56-4aef-9311-4c748b7969e1';

  const fetcher: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/api/v1/flows/')) {
      postedBodies.push(JSON.parse(init?.body as string));
      return json({ id: mockFlowId, name: 'Published Flow' });
    }
    return json({ detail: 'not found' }, 404);
  }) as typeof fetch;

  const app = await createApp({ dataDir: directory, langflowFetch: fetcher });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  // 1. 创建工作流
  const createRes = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: { revision: 0, workflow: starterDefinition },
  });
  assert.equal(createRes.statusCode, 201);
  const workflowId = createRes.json().workflow.id;

  // 2. 调用发布接口
  const publishRes = await app.inject({
    method: 'POST',
    url: `/api/workflows/${workflowId}/publish-langflow`,
  });

  assert.equal(publishRes.statusCode, 200);
  const publishBody = publishRes.json();
  assert.equal(publishBody.flowId, mockFlowId);
  assert.equal(publishBody.workflowId, workflowId);
  assert.equal(publishBody.projectId, 'default');

  assert.equal(postedBodies.length, 1);
  assert.equal(postedBodies[0].name, starterDefinition.name);
  assert.equal(postedBodies[0].data.nodes.length, 5);

  // 3. 发布不存在的工作流返回 404
  const notFoundRes = await app.inject({
    method: 'POST',
    url: '/api/workflows/00000000-0000-0000-0000-000000000000/publish-langflow',
  });
  assert.equal(notFoundRes.statusCode, 404);
  assert.equal(notFoundRes.json().error.code, 'WORKFLOW_NOT_FOUND');
});
