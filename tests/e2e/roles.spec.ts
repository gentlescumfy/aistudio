import { expect, test } from '@playwright/test';

const apiBase = 'http://127.0.0.1:4000';

test('role template copy, edits, revisions and archive work against the actual API', async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const initial = await (await request.get(`${apiBase}/api/roles`)).json();
  expect(initial.roles.filter((role: { builtIn: boolean }) => role.builtIn)).toHaveLength(7);
  expect(initial.runtime.enabled).toBe(false);
  test.skip(initial.roles.filter((role: { builtIn: boolean }) => !role.builtIn).length >= 64, 'Local custom role capacity reached.');
  let createdId: string | undefined;
  let archived = false;
  const name = `浏览器验收角色 ${Date.now()}`;
  try {
    await page.goto('/');
    await page.getByRole('link', { name: '代理角色', exact: true }).click();
    await expect(page.getByRole('heading', { name: '代理角色', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '复制为自定义角色' })).toBeVisible();
    const copiedResponse = page.waitForResponse(response => response.url().endsWith('/api/roles') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '复制为自定义角色' }).click();
    const copied = await (await copiedResponse).json(); createdId = copied.role.id;
    expect(copied.role.revision).toBe(1);
    await page.getByRole('button', { name: '编辑草稿', exact: true }).click();
    const editor = page.getByRole('region', { name: '角色编辑器' });
    await editor.getByLabel(/^角色名称/).fill(name);
    await editor.getByLabel(/^系统提示词/).fill('你是品牌文案策划，按输入要求输出中文文案，并列出需要人工确认的内容。');
    await editor.getByLabel(/^输入契约说明/).fill('品牌定位、目标受众和文案长度。');
    await editor.getByLabel(/^输出契约说明/).fill('三条文案和待确认项。');
    await editor.getByRole('checkbox', { name: /assets.read/ }).check();
    const savedResponse = page.waitForResponse(response => response.url().endsWith(`/api/roles/${createdId}`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存角色草稿', exact: true }).click();
    const saved = await (await savedResponse).json();
    expect(saved.role.revision).toBe(2);
    expect(saved.role.tools).toContain('assets.read');
    await page.reload();
    await page.getByRole('searchbox', { name: '搜索角色' }).fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看修订历史', exact: true }).click();
    const history = page.getByRole('region', { name: '角色修订历史' });
    await expect(history.locator('li')).toHaveCount(2);
    const revisions = await (await request.get(`${apiBase}/api/roles/${createdId}/revisions`)).json();
    expect(revisions.revisions[0].revision).toBe(1);
    expect(revisions.revisions[0].systemPrompt).not.toBe(revisions.revisions[1].systemPrompt);
    await page.screenshot({ path: testInfo.outputPath('roles-desktop-dark.png'), fullPage: true });
    await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('light');
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.screenshot({ path: testInfo.outputPath('roles-mobile-light.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '归档角色', exact: true }).click();
    await expect(page.getByRole('button', { name: '编辑草稿', exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    const archiveResponse = page.waitForResponse(response => response.url().endsWith(`/api/roles/${createdId}/archive`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '归档角色', exact: true }).click();
    const result = await (await archiveResponse).json(); archived = result.role.lifecycle === 'archived';
    expect(archived).toBe(true);
    await page.getByRole('combobox', { name: '角色状态筛选' }).selectOption('archived');
    await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
    expect((await (await request.get(`${apiBase}/api/roles/${createdId}/revisions`)).json()).revisions).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    if (createdId && !archived) {
      const current = await (await request.get(`${apiBase}/api/roles`)).json();
      const cleanup = await request.post(`${apiBase}/api/roles/${createdId}/archive`, { data: { revision: current.revision } });
      expect([200, 409]).toContain(cleanup.status());
    }
  }
});

test('unsaved role editor keeps changes when navigation is cancelled', async ({ page }) => {
  await page.goto('/#roles');
  await page.getByRole('button', { name: '新建自定义角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: false }).fill('未保存的角色草稿');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: '配置中心', exact: true }).click();
  await expect(page.getByLabel('角色名称', { exact: false })).toHaveValue('未保存的角色草稿');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('link', { name: /^创作工作台/ }).click();
  await expect(page.getByRole('heading', { name: '创作工作台', exact: true })).toBeVisible();
});

test('custom role selects a full model binding and reports removed references', async ({ page, request }) => {
  const initial = await (await request.get(`${apiBase}/api/settings`)).json();
  const roles = await (await request.get(`${apiBase}/api/roles`)).json();
  test.skip(initial.settings.providers.length >= 8 || initial.settings.accounts.length >= 16 || initial.settings.models.length >= 64 || roles.roles.filter((role: { builtIn: boolean }) => !role.builtIn).length >= 64, 'Local metadata capacity reached.');
  const stamp = Date.now();
  const provider = { id: `role-provider-${stamp}`, name: '角色验收供应商', transport: 'api', protocol: 'openai-compatible', baseUrl: 'https://example.com/v1' };
  const account = { id: `role-account-${stamp}`, providerId: provider.id, label: '角色验收账号', secretEnv: '', enabled: true };
  const model = { id: `role-model-${stamp}`, accountId: account.id, externalId: 'declared-planner', name: '角色验收文本模型', capabilities: ['text'], pinned: false };
  const configured = await request.post(`${apiBase}/api/settings`, { data: { schemaVersion: 2, revision: initial.revision, settings: {
    ...initial.settings, providers: [...initial.settings.providers, provider], accounts: [...initial.settings.accounts, account], models: [...initial.settings.models, model],
  } } });
  expect(configured.status()).toBe(200);
  const settingsRevision = (await configured.json()).revision;
  let restored = false;
  let roleId: string | undefined;
  const name = `模型绑定角色 ${stamp}`;
  try {
    await page.goto('/#roles');
    await page.getByRole('button', { name: '新建自定义角色', exact: true }).click();
    const editor = page.getByRole('region', { name: '角色编辑器' });
    await editor.getByLabel(/^角色名称/).fill(name);
    await editor.getByLabel(/^角色描述/).fill('测试角色的指定模型与失效提示。');
    await editor.getByLabel(/^系统提示词/).fill('仅根据输入生成计划，保留需要人工确认的事项。');
    await editor.getByLabel(/^输入契约说明/).fill('任务需求与约束。');
    await editor.getByLabel(/^输出契约说明/).fill('计划和待确认事项。');
    await page.getByRole('combobox', { name: '角色默认模型' }).selectOption({ label: '角色验收供应商 / 角色验收账号 / 角色验收文本模型' });
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/roles') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '创建角色草稿', exact: true }).click();
    const saved = await (await responsePromise).json(); roleId = saved.role.id;
    expect(saved.role.modelStatus).toBe('configured');
    expect(saved.role.modelSelection.binding).toEqual({ providerId: provider.id, accountId: account.id, modelId: model.id });
    const restoration = await request.post(`${apiBase}/api/settings`, { data: { schemaVersion: 2, revision: settingsRevision, settings: initial.settings } });
    expect(restoration.status()).toBe(200); restored = true;
    await page.reload();
    await page.getByRole('searchbox', { name: '搜索角色' }).fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.getByRole('region', { name: '角色详情' }).getByText('绑定不可用', { exact: true })).toBeVisible();
    const current = await (await request.get(`${apiBase}/api/roles`)).json();
    expect(current.roles.find((role: { id: string }) => role.id === roleId).modelSelection.binding).toEqual(saved.role.modelSelection.binding);
  } finally {
    if (!restored) {
      const cleanup = await request.post(`${apiBase}/api/settings`, { data: { schemaVersion: 2, revision: settingsRevision, settings: initial.settings } });
      expect([200, 409]).toContain(cleanup.status());
    }
    if (roleId) {
      const current = await (await request.get(`${apiBase}/api/roles`)).json();
      const cleanup = await request.post(`${apiBase}/api/roles/${roleId}/archive`, { data: { revision: current.revision } });
      expect([200, 409]).toContain(cleanup.status());
    }
  }
});
