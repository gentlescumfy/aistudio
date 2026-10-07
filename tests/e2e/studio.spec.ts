import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const apiBase = 'http://127.0.0.1:4000';

async function openStudio(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Studio API 已连接', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始创作' })).toBeEnabled();
}

async function createRun(page: Page, prompt: string, count = 1) {
  await page.getByLabel('素材描述').fill(prompt);
  await page.getByLabel('生成数量').fill(String(count));
  const responsePromise = page.waitForResponse(response =>
    response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始创作' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  return (await response.json()).run;
}

test('real API: create, preview, keyboard close, download and recover history', async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openStudio(page);
  const prompt = `浏览器验收咖啡品牌 ${Date.now()}`;
  const run = await createRun(page, prompt, 2);
  await expect(page.locator('.execution-section').getByText('创作已完成', { exact: false })).toBeVisible();
  const gallery = page.getByRole('region', { name: '生成资产' });
  await expect(gallery.locator('article')).toHaveCount(2);
  await expect(gallery.locator('img').first()).toBeVisible();
  expect(await gallery.locator('img').first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1024);
  await gallery.getByRole('button', { name: '预览 mock-brand-1.svg', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(gallery.getByRole('button', { name: '预览 mock-brand-1.svg', exact: true })).toBeFocused();
  const downloadPromise = page.waitForEvent('download');
  await gallery.getByRole('button', { name: '下载 mock-brand-1.svg', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('mock-brand-1.svg');
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path!, 'utf8')).toContain('NOT AI GENERATED');
  const actual = (await (await request.get(`${apiBase}/api/runs/${run.id}`)).json()).run;
  expect(actual.status).toBe('succeeded');
  expect(actual.assets).toHaveLength(2);
  expect(actual.nodes.map((node: { attempts: number }) => node.attempts)).toEqual([1, 1, 1]);
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(prompt) })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(prompt) }).click();
  await expect(gallery.locator('article')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('studio-desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('real API: retry only failed work and cancel active run', async ({ page, request }) => {
  await openStudio(page);
  const failed = await createRun(page, `浏览器失败演示 [mock:fail-once] ${Date.now()}`);
  await expect(page.getByRole('button', { name: '重试失败节点' })).toBeVisible();
  await page.getByRole('button', { name: '重试失败节点' }).click();
  await expect(page.locator('.execution-section').getByText('创作已完成', { exact: false })).toBeVisible();
  const retried = (await (await request.get(`${apiBase}/api/runs/${failed.id}`)).json()).run;
  expect(retried.nodes.map((node: { attempts: number }) => node.attempts)).toEqual([1, 2, 1]);
  const cancelled = await createRun(page, `浏览器取消演示 ${Date.now()}`, 8);
  await page.getByRole('button', { name: '取消运行', exact: true }).click();
  await expect(page.locator('.execution-section').getByText('创作已取消', { exact: false })).toBeVisible();
  const state = (await (await request.get(`${apiBase}/api/runs/${cancelled.id}`)).json()).run;
  expect(state.status).toBe('cancelled');
  expect(state.nodes.some((node: { status: string }) => node.status === 'cancelled')).toBe(true);
});

test('320px viewport has no horizontal overflow and creation remains reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openStudio(page);
  await page.getByLabel('素材描述').fill('窄屏键盘操作验收');
  await page.getByLabel('生成数量').fill('1');
  await page.getByRole('button', { name: '开始创作' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '开始创作' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('studio-mobile.png'), fullPage: true });
});
