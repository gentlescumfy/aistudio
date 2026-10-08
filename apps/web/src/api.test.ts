import { describe, expect, it } from 'vitest';
import { api, assetUrl, validateInputs } from './api';
import { makeSettingsResponse, sampleSettings } from './test-fixtures';
import type { Workflow, WorkflowDefinition, WorkflowLibrary } from './types';
import type { LangflowConfig, LangflowFlow, LangflowRun } from './types';

const workflowDefinition: WorkflowDefinition = {
  name: '品牌图像工作流', description: '提示词与图像生成流程。',
  nodes: [
    { id: 'prompt-main', name: '创意提示词', kind: 'prompt', position: { x: 30, y: 50 }, config: { template: '{{prompt}}', roleRef: null } },
    { id: 'image-main', name: '图像生成', kind: 'image', position: { x: 280, y: 50 }, config: { width: 1024, height: 1024, count: null } },
    { id: 'export-main', name: '导出素材', kind: 'export', position: { x: 530, y: 50 }, config: {} },
  ],
  edges: [{ id: 'edge-one', source: 'prompt-main', target: 'image-main' }, { id: 'edge-two', source: 'image-main', target: 'export-main' }],
};
const workflow: Workflow = {
  ...workflowDefinition, id: '8bb3500d-0734-48e8-81c5-96c5131ecfc9', revision: 2, lifecycle: 'published', publishedRevision: 2,
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', roleSnapshots: [],
};
const workflowLibrary: WorkflowLibrary = {
  revision: 3, workflows: [workflow], starterDefinition: workflowDefinition,
  runtime: { mode: 'mixed', executableKinds: ['prompt', 'image', 'export'], agentExecutionEnabled: true },
};
const langflowConfig: LangflowConfig = { baseUrl: 'http://127.0.0.1:7860', authMode: 'local-development', secretEnv: '', timeoutMs: 30000 };
const langflowFlow: LangflowFlow = { id: '18b59ef1-65a0-4a92-9b84-57ed19926d5e', name: 'Echo', description: '原生输入输出回显流程。', updatedAt: '2026-10-07T00:00:00.000Z' };
const langflowRun: LangflowRun = {
  id: 'run-receipt-1', flowId: langflowFlow.id, flowName: langflowFlow.name, input: 'hello', status: 'succeeded',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:01.000Z', output: 'hello', error: null, provider: 'langflow',
};

describe('输入与 API 契约', () => {
  it('拒绝空白、超长描述与越界或非整数数量', () => {
    expect(validateInputs('  ', 2)).toMatch(/描述/);
    expect(validateInputs('a'.repeat(2001), 2)).toMatch(/2000/);
    for (const count of [0, 9, 1.5, NaN]) expect(validateInputs('品牌', count)).toMatch(/整数/);
    expect(validateInputs('  品牌  ', 8)).toBeNull();
  });
  it('解析 API 资产地址并拒绝脚本协议', () => {
    expect(assetUrl('/assets/demo.svg')).toBe('http://localhost:4000/assets/demo.svg');
    expect(() => assetUrl('javascript:alert(1)')).toThrow('资产地址无效');
  });
  it('保留结构化服务端错误供用户恢复', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'TEMPLATE_DISABLED', message: '模板尚未开放' } }, { status: 409 })));
    await expect(api.create('video', { prompt: '品牌', count: 1 }, 'key', new AbortController().signal)).rejects.toMatchObject({ code: 'TEMPLATE_DISABLED', status: 409, message: '模板尚未开放' });
  });
  it('拒绝缺少运行字段的成功响应，避免渲染崩溃', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ run: {} })));
    await expect(api.run('broken', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('读取并校验 v2 配置结构、归属完整的默认绑定和凭据状态', async () => {
    const settings = sampleSettings();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(makeSettingsResponse(settings))));
    await expect(api.settings(new AbortController().signal)).resolves.toMatchObject({ schemaVersion: 2, settings: { routes: { text: settings.routes.text } }, runtime: { externalProvidersEnabled: false } });
  });
  it('拒绝旧 schema 与跨供应商不匹配的默认绑定', async () => {
    const valid = makeSettingsResponse(sampleSettings());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...valid, schemaVersion: 1 })));
    await expect(api.settings(new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...valid, settings: { ...valid.settings, routes: { ...valid.settings.routes, text: { providerId: 'provider-elsewhere', accountId: 'account-main', modelId: 'model-main' } } } })));
    await expect(api.settings(new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('保存配置时发送 v2 版本号和完整设置', async () => {
    const settings = sampleSettings(); const fetchMock = vi.fn().mockResolvedValue(Response.json(makeSettingsResponse(settings, 6)));
    vi.stubGlobal('fetch', fetchMock);
    await api.saveSettings(5, settings, new AbortController().signal);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ schemaVersion: 2, revision: 5, settings });
  });

  it('校验工作流目录快照并按目录修订提交草稿', async () => {
    const draft = { ...workflowDefinition, name: '编辑后的工作流' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(workflowLibrary))
      .mockResolvedValueOnce(Response.json({ revision: 4, workflow: { ...workflow, ...draft, revision: 3, lifecycle: 'draft', publishedRevision: null } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.workflows(new AbortController().signal)).resolves.toMatchObject({ revision: 3, workflows: [{ id: workflow.id, nodes: workflowDefinition.nodes }] });
    await expect(api.createWorkflow(3, draft, new AbortController().signal)).resolves.toMatchObject({ revision: 4, workflow: { name: draft.name } });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ revision: 3, workflow: draft });
  });

  it('验证模板运行请求中的工作流修订号随幂等请求一起发送', async () => {
    const run = { id: 'run-workflow', templateId: 'workflow-1', status: 'queued', inputs: { prompt: '品牌视觉', count: 2 }, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', mode: 'mock', nodes: [], assets: [], estimatedCost: 0, actualCost: 0 };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ run }));
    vi.stubGlobal('fetch', fetchMock);
    await api.create('workflow-1', { prompt: '品牌视觉', count: 2 }, 'stable-key', new AbortController().signal, 5);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ templateId: 'workflow-1', workflowRevision: 5, idempotencyKey: 'stable-key' });
  });

  it('读取 Langflow 配置、状态、原生流程元数据和结果历史', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ revision: 2, config: langflowConfig, credentialConfigured: false }))
      .mockResolvedValueOnce(Response.json({ connected: true, version: '1.12.5', editorUrl: langflowConfig.baseUrl, authMode: 'local-development', message: 'Langflow 已连接。' }))
      .mockResolvedValueOnce(Response.json({ flows: [langflowFlow] }))
      .mockResolvedValueOnce(Response.json({ runs: [langflowRun] }))
      .mockResolvedValueOnce(Response.json({ run: langflowRun }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.langflowConfig(new AbortController().signal)).resolves.toMatchObject({ revision: 2, config: langflowConfig, credentialConfigured: false });
    await expect(api.langflowStatus(new AbortController().signal)).resolves.toMatchObject({ connected: true, version: '1.12.5' });
    await expect(api.langflowFlows(new AbortController().signal)).resolves.toEqual({ flows: [langflowFlow] });
    await expect(api.langflowRuns(new AbortController().signal)).resolves.toEqual({ runs: [langflowRun] });
    await expect(api.langflowRun(langflowRun.id, new AbortController().signal)).resolves.toEqual({ run: langflowRun });
  });

  it('保存连接配置和显式运行输入时只发送修订、变量名及幂等键', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ revision: 3, config: { ...langflowConfig, authMode: 'api-key-env', secretEnv: 'LANGFLOW_API_KEY' }, credentialConfigured: true }))
      .mockResolvedValueOnce(Response.json({ run: { ...langflowRun, id: 'run-receipt-2', status: 'queued', output: null } }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { ...langflowConfig, authMode: 'api-key-env' as const, secretEnv: 'LANGFLOW_API_KEY' };
    await api.saveLangflowConfig(2, config, new AbortController().signal);
    const runIdempotencyKey = 'a'.repeat(48);
    await api.createLangflowRun(langflowFlow.id, 'hello', runIdempotencyKey, new AbortController().signal);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ revision: 2, config });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ flowId: langflowFlow.id, input: 'hello', idempotencyKey: runIdempotencyKey });
  });

  it('拒绝包含令牌或非本机地址的 Langflow 配置响应', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ revision: 1, config: { ...langflowConfig, apiKey: 'raw-secret' }, credentialConfigured: true })));
    await expect(api.langflowConfig(new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ revision: 1, config: { ...langflowConfig, baseUrl: 'https://example.com' }, credentialConfigured: false })));
    await expect(api.langflowConfig(new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
