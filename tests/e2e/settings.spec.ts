import { expect, test } from '@playwright/test';

const apiBase = 'http://127.0.0.1:4000';

test('configuration saves provider/accounts/models, pins and bindings across reload', async ({ page, request }, testInfo) => {
  const initial = await (await request.get(`${apiBase}/api/settings`)).json();
  expect(initial.schemaVersion).toBe(2);
  test.skip(initial.settings.providers.length >= 8 || initial.settings.accounts.length > 14 || initial.settings.models.length > 61, 'No available draft slots in this development workspace.');
  let savedRevision: number | undefined;
  const defaultCount = initial.settings.defaultCount === 2 ? 3 : 2;
  const name = `验收供应商 ${Date.now()}`;
  try {
    await page.goto('/');
    await page.getByRole('link', { name: '配置中心' }).click();
    await expect(page.getByRole('heading', { name: '工作台配置' })).toBeVisible();
    await page.getByLabel('默认生成数量').fill(String(defaultCount));
    await page.getByRole('button', { name: '添加供应商' }).click();
    await page.getByLabel('供应商名称').last().fill(name);
    const card = page.getByRole('region', { name: `供应商 ${name}`, exact: true });
    await card.getByLabel('服务基础地址').fill('https://example.com/v1');
    await card.getByRole('button', { name: '添加账号', exact: true }).click();
    await card.getByLabel('账号名称').last().fill('团队账号');
    const teamAccount = card.getByRole('region', { name: '账号 团队账号', exact: true });
    await teamAccount.getByLabel('密钥环境变量名', { exact: false }).fill('AISTUDIO_DRAFT_API_KEY');
    await teamAccount.getByRole('button', { name: '添加模型', exact: true }).click();
    let model = teamAccount.locator('.model-card').last();
    await model.getByLabel('显示名称').fill('团队文本模型');
    await model.getByLabel('供应商模型 ID').fill('draft-text-model');
    await model.getByRole('button', { name: '收藏 团队文本模型', exact: true }).click();
    await teamAccount.getByRole('button', { name: '添加模型', exact: true }).click();
    model = teamAccount.locator('.model-card').last();
    await model.getByLabel('显示名称').fill('品牌图像模型');
    await model.getByLabel('供应商模型 ID').fill('draft-image-model');
    await model.getByRole('checkbox', { name: '文本', exact: true }).uncheck();
    await model.getByRole('checkbox', { name: '图像', exact: true }).check();
    await card.getByRole('button', { name: '添加账号', exact: true }).click();
    await card.getByLabel('账号名称').last().fill('个人账号');
    const personalAccount = card.getByRole('region', { name: '账号 个人账号', exact: true });
    await personalAccount.getByRole('button', { name: '添加模型', exact: true }).click();
    model = personalAccount.locator('.model-card').last();
    await model.getByLabel('显示名称').fill('个人文本模型');
    await model.getByLabel('供应商模型 ID').fill('draft-text-model');
    await page.getByLabel('文本与代码', { exact: true }).selectOption({ label: `${name} / 个人账号 / 个人文本模型` });
    await page.getByLabel('默认图像模型绑定', { exact: true }).selectOption({ label: `${name} / 团队账号 / 品牌图像模型（未启用草稿）` });
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const saved = await response.json(); savedRevision = saved.revision;
    expect(saved.schemaVersion).toBe(2);
    const savedProvider = saved.settings.providers.find((provider: { name: string }) => provider.name === name);
    const savedAccounts = saved.settings.accounts.filter((account: { providerId: string }) => account.providerId === savedProvider.id);
    expect(savedAccounts).toHaveLength(2);
    expect(saved.settings.routes.text.accountId).toBe(savedAccounts.find((account: { label: string }) => account.label === '个人账号').id);
    expect(saved.settings.routes.image.accountId).toBe(savedAccounts.find((account: { label: string }) => account.label === '团队账号').id);
    expect(saved.runtime.externalProvidersEnabled).toBe(false);
    await expect(page.getByText('配置已保存', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('默认生成数量')).toHaveValue(String(defaultCount));
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByText('当前执行：本地模拟模型', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消收藏 团队文本模型', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('searchbox', { name: '搜索供应商、账号或模型' }).fill('品牌图像模型');
    await expect(card.locator('.model-card')).toHaveCount(1);
    await page.getByRole('searchbox', { name: '搜索供应商、账号或模型' }).fill('');
    await page.getByRole('button', { name: /仅显示收藏/ }).click();
    await expect(card.locator('.model-card')).toHaveCount(1);
    await expect(card.locator('.model-card')).toContainText('团队文本模型');
    await page.getByRole('button', { name: /仅显示收藏/ }).click();
    await page.screenshot({ path: testInfo.outputPath('settings-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.screenshot({ path: testInfo.outputPath('settings-populated-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '删除模型 品牌图像模型', exact: true }).click();
    await expect(page.getByLabel('默认图像模型绑定', { exact: true })).toHaveValue('mock-svg');
    // Discard deletion draft explicitly; leave the persisted saved config unchanged until cleanup.
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('link', { name: '创作工作台' }).click();
    await expect(page.getByLabel('生成数量')).toHaveValue(String(defaultCount));
  } finally {
    if (savedRevision !== undefined) {
      // Restore only if nobody else has written a newer revision during this test.
      const restored = await request.post(`${apiBase}/api/settings`, { data: { schemaVersion: 2, revision: savedRevision, settings: initial.settings } });
      expect([200, 409]).toContain(restored.status());
    }
  }
});

test('configuration is directly addressable and usable at 320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/#settings');
  await expect(page.getByLabel('默认生成数量')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加供应商' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png'), fullPage: true });
});

test('unsaved configuration warns before internal navigation and allows keeping edits', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.getByLabel('默认生成数量')).toBeVisible();
  await page.getByRole('button', { name: '添加供应商' }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: '创作工作台' }).click();
  await expect(page.getByRole('heading', { name: '工作台配置' })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('link', { name: '创作工作台' }).click();
  await expect(page.getByRole('heading', { name: '创作工作台', exact: true })).toBeVisible();
});
