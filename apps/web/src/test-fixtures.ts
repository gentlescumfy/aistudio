import type { AccountConfig, ModelBinding, ModelConfig, Run, SettingsResponse, StudioSettings, Template } from './types';
export const template: Template = {
  id: 'brand-image', name: '品牌视觉素材', description: '生成品牌视觉方向与图像素材',
  category: 'image', enabled: true,
  nodes: [{ id: 'plan', name: '创意规划', kind: 'prompt' }, { id: 'generate', name: '图像生成', kind: 'image' }],
};
export const defaultSettings: StudioSettings = { defaultCount: 4, providers: [], accounts: [], models: [], routes: { text: null, image: 'mock-svg', video: null } };
export const makeSettingsResponse = (settings: StudioSettings = defaultSettings, revision = 1): SettingsResponse => ({
  schemaVersion: 2, revision, settings: structuredClone(settings),
  runtime: { mode: 'mock', activeImageModel: 'mock-svg', externalProvidersEnabled: false },
  credentials: settings.accounts.map((account: AccountConfig) => ({ accountId: account.id, configured: !!account.secretEnv })),
});
export const sampleSettings = (): StudioSettings => {
  const account: AccountConfig = { id: 'account-main', providerId: 'provider-main', label: '团队账号', secretEnv: '', enabled: true };
  const model: ModelConfig = { id: 'model-main', accountId: account.id, externalId: 'text-v1', name: '文本模型', capabilities: ['text', 'code'], pinned: true };
  const binding: ModelBinding = { providerId: account.providerId, accountId: account.id, modelId: model.id };
  return { defaultCount: 4, providers: [{ id: account.providerId, name: '示例供应商', transport: 'api', protocol: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }], accounts: [account], models: [model], routes: { text: binding, image: 'mock-svg', video: null } };
};
export const makeRun = (status: Run['status'] = 'running'): Run => ({
  id: 'run-1', templateId: template.id, status, inputs: { prompt: '极简咖啡', count: 4 },
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:01.000Z', mode: 'mock',
  nodes: template.nodes.map((node, index) => ({ ...node, status: index === 0 ? 'succeeded' : status === 'failed' ? 'failed' : status === 'succeeded' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'running', attempts: 1 })),
  assets: [], estimatedCost: 0, actualCost: 0,
});
export function installApi(history: Run[] = [], create?: (body: Record<string, unknown>) => Promise<Response>, initialSettings: StudioSettings = defaultSettings) {
  let runs = history;
  let settings = makeSettingsResponse(initialSettings);
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('http://localhost:4000', '');
    if (path === '/api/settings' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { schemaVersion: 2; revision: number; settings: StudioSettings };
      settings = makeSettingsResponse(body.settings, settings.revision + 1);
      return Response.json(settings);
    }
    if (path === '/api/settings') return Response.json(settings);
    if (path === '/api/health') return Response.json({ status: 'ok', mode: 'mock' });
    if (path === '/api/templates') return Response.json({ templates: [template] });
    if (path === '/api/runs' && init?.method === 'POST') {
      if (create) {
        const response = await create(JSON.parse(init.body as string) as Record<string, unknown>);
        if (response.ok) runs = [(await response.clone().json() as { run: Run }).run];
        return response;
      }
      const run = makeRun(); runs = [run]; return Response.json({ run }, { status: 201 });
    }
    if (path === '/api/runs') return Response.json({ runs });
    if (path.endsWith('/cancel')) { const run = makeRun('cancelled'); runs = [run]; return Response.json({ run }); }
    if (path.endsWith('/retry')) { const run = makeRun(); runs = [run]; return Response.json({ run }); }
    if (path === '/api/runs/run-1') return Response.json({ run: runs[0] });
    return Response.json({ error: { code: 'NOT_FOUND', message: '运行不存在' } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
