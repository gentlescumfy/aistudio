import { expect, test, type APIRequestContext } from '@playwright/test';

const apiBase = 'http://127.0.0.1:4000';

async function waitForRun(request: APIRequestContext, id: string) {
  await expect.poll(async () => (await (await request.get(`${apiBase}/api/runs/${id}`)).json()).run.status).toBe('succeeded');
  return (await (await request.get(`${apiBase}/api/runs/${id}`)).json()).run;
}

async function archiveWorkflow(request: APIRequestContext, id: string) {
  const library = await (await request.get(`${apiBase}/api/workflows`)).json();
  const response = await request.post(`${apiBase}/api/workflows/${id}/archive`, { data: { revision: library.revision } });
  expect([200, 409]).toContain(response.status());
}

test('published workflow parameters drive mock execution and old run snapshots survive edits', async ({ page, request }) => {
  const library = await (await request.get(`${apiBase}/api/workflows`)).json();
  test.skip(library.workflows.length >= 64, 'Local workflow capacity reached.');
  const definition = structuredClone(library.starterDefinition);
  definition.name = `配置化流程验收 ${Date.now()}`;
  definition.description = '实际运行节点参数与发布快照。';
  const prompt = definition.nodes.find((node: { kind: string }) => node.kind === 'prompt');
  const image = definition.nodes.find((node: { kind: string }) => node.kind === 'image');
  prompt.config.template = '配置提示词前缀：{{prompt}}（默认批量 {{count}}）';
  const roleLibrary = await (await request.get(`${apiBase}/api/roles`)).json();
  const role = roleLibrary.roles.find((item: { id: string }) => item.id === 'scriptwriter');
  prompt.config.roleRef = { id: role.id, revision: role.revision };
  image.config = { width: 1280, height: 720, count: 2 };
  const createdResponse = await request.post(`${apiBase}/api/workflows`, { data: { revision: library.revision, workflow: definition } });
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  let archived = false;
  try {
    const publishedResponse = await request.post(`${apiBase}/api/workflows/${created.workflow.id}/publish`, { data: { revision: created.revision } });
    expect(publishedResponse.status()).toBe(200);
    const published = await publishedResponse.json();
    expect(published.workflow.roleSnapshots[0].role.revision).toBe(role.revision);
    await page.goto('/');
    await page.getByRole('button', { name: new RegExp(definition.name) }).click();
    await page.getByLabel('素材描述').fill('草本品牌');
    await page.getByLabel('生成数量').fill('1');
    const submittedResponse = page.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    const submitted = await submittedResponse;
    expect(submitted.status()).toBe(201);
    const originalBody = submitted.request().postDataJSON();
    expect(originalBody.workflowRevision).toBe(published.workflow.publishedRevision);
    const runId = (await submitted.json()).run.id;
    const run = await waitForRun(request, runId);
    expect(run.expectedAssetCount).toBe(2);
    expect(run.assets).toHaveLength(2);
    expect(run.assets.every((asset: { width: number; height: number }) => asset.width === 1280 && asset.height === 720)).toBe(true);
    const svg = await (await request.get(`${apiBase}${run.assets[0].url}`)).text();
    expect(svg).toContain('width="1280"'); expect(svg).toContain('height="720"');
    expect(svg).toContain('配置提示词前缀');
    expect(run.workflowSnapshot.revision).toBe(published.workflow.publishedRevision);
    expect(run.workflowSnapshot.roleSnapshots[0].role.systemPrompt).toBe(role.systemPrompt);
    await expect(page.getByRole('region', { name: '生成资产' }).locator('article')).toHaveCount(2);

    const changed = structuredClone(definition);
    changed.nodes.find((node: { kind: string }) => node.kind === 'image').config = { width: 512, height: 512, count: 1 };
    const edited = await (await request.post(`${apiBase}/api/workflows/${created.workflow.id}`, { data: { revision: published.revision, workflow: changed } })).json();
    expect(edited.workflow.publishedRevision).toBe(published.workflow.publishedRevision);
    const republishedResponse = await request.post(`${apiBase}/api/workflows/${created.workflow.id}/publish`, { data: { revision: edited.revision } });
    expect(republishedResponse.status()).toBe(200);
    const republished = await republishedResponse.json();
    const replay = await request.post(`${apiBase}/api/runs`, { data: originalBody });
    expect(replay.status()).toBe(200); expect((await replay.json()).run.id).toBe(runId);
    const old = (await (await request.get(`${apiBase}/api/runs/${runId}`)).json()).run;
    expect(old.workflowSnapshot.revision).toBe(published.workflow.publishedRevision);
    expect(old.assets[0].width).toBe(1280);
    const currentBody = { ...originalBody, workflowRevision: republished.workflow.publishedRevision, idempotencyKey: `workflow-new-${Date.now()}` };
    const latestResponse = await request.post(`${apiBase}/api/runs`, { data: currentBody });
    expect(latestResponse.status()).toBe(201);
    const latest = await waitForRun(request, (await latestResponse.json()).run.id);
    expect(latest.assets).toHaveLength(1); expect(latest.assets[0].width).toBe(512);
    await archiveWorkflow(request, created.workflow.id); archived = true;
    expect((await request.post(`${apiBase}/api/runs`, { data: originalBody })).status()).toBe(200);
    expect((await request.post(`${apiBase}/api/runs`, { data: { ...currentBody, idempotencyKey: `archived-new-${Date.now()}` } })).status()).toBe(409);
  } finally { if (!archived) await archiveWorkflow(request, created.workflow.id); }
});

test('workflow validation rejects invalid links and image branches produce distinct assets', async ({ request }) => {
  const library = await (await request.get(`${apiBase}/api/workflows`)).json();
  test.skip(library.workflows.length >= 64, 'Local workflow capacity reached.');
  const definition = structuredClone(library.starterDefinition);
  definition.name = `分支流程验收 ${Date.now()}`;
  const prompt = definition.nodes.find((node: { kind: string }) => node.kind === 'prompt');
  const exporter = definition.nodes.find((node: { kind: string }) => node.kind === 'export');
  const invalid = structuredClone(definition);
  invalid.edges.push({ id: 'invalid-back-edge', source: exporter.id, target: prompt.id });
  const validation = await (await request.post(`${apiBase}/api/workflows/validate`, { data: { workflow: invalid } })).json();
  expect(validation.valid).toBe(false); expect(validation.issues.length).toBeGreaterThan(0);
  definition.nodes.push({ id: 'alternate-image', name: '副画面', kind: 'image', position: { x: 400, y: 260 }, config: { width: 512, height: 512, count: 1 } });
  definition.edges.push({ id: 'alternate-input', source: prompt.id, target: 'alternate-image' }, { id: 'alternate-output', source: 'alternate-image', target: exporter.id });
  const createdResponse = await request.post(`${apiBase}/api/workflows`, { data: { revision: library.revision, workflow: definition } });
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  try {
    const publishedResponse = await request.post(`${apiBase}/api/workflows/${created.workflow.id}/publish`, { data: { revision: created.revision } });
    expect(publishedResponse.status()).toBe(200);
    const published = await publishedResponse.json();
    const response = await request.post(`${apiBase}/api/runs`, { data: { templateId: created.workflow.id, workflowRevision: published.workflow.publishedRevision, inputs: { prompt: '分支素材', count: 2 }, idempotencyKey: `branch-${Date.now()}` } });
    expect(response.status()).toBe(201);
    const run = await waitForRun(request, (await response.json()).run.id);
    expect(run.expectedAssetCount).toBe(3); expect(run.assets).toHaveLength(3);
    expect(new Set(run.assets.map((asset: { id: string }) => asset.id)).size).toBe(3);
    expect(run.assets.filter((asset: { nodeId: string }) => asset.nodeId === 'alternate-image')).toHaveLength(1);
    expect(run.nodes.every((node: { status: string }) => node.status === 'succeeded')).toBe(true);
  } finally { await archiveWorkflow(request, created.workflow.id); }
});
