import { expect, test } from '@playwright/test';
// The fixture verifies native component code and contains no model/provider node.
// @ts-expect-error The fixture is a plain JavaScript coordinator script.
import { ensureEcho, echoName } from '../../scripts/langflow-echo.mjs';

const apiBase = 'http://127.0.0.1:4000';

test('Studio lists native Langflow flows, opens its editor and executes the real Echo API', async ({ page, request }, testInfo) => {
  const echo = await ensureEcho();
  const status = await (await request.get(`${apiBase}/api/langflow/status`)).json();
  expect(status.connected).toBe(true);
  expect(status.version).toBe('1.12.5');
  await page.goto('/#workflows');
  await expect(page.getByRole('status', { name: 'Langflow 连接状态' })).toContainText('Langflow 已连接');
  await page.getByRole('region', { name: 'Langflow 原生流程列表' }).getByRole('button', { name: new RegExp(echoName.replace(/[()]/g, '\\$&')) }).click();
  const editorLink = page.getByRole('link', { name: /打开 Langflow 原生编辑器/ });
  await expect(editorLink).toHaveAttribute('target', '_blank');
  const popupPromise = page.waitForEvent('popup');
  await editorLink.click();
  const editor = await popupPromise;
  await editor.waitForURL('http://127.0.0.1:7860/**');
  await editor.waitForLoadState('domcontentloaded');
  expect(new URL(editor.url()).origin).toBe('http://127.0.0.1:7860');
  await editor.getByRole('button', { name: new RegExp(echoName) }).first().click();
  await expect(editor.locator('.react-flow')).toBeVisible({ timeout: 30_000 });
  await expect(editor.locator('.react-flow__node')).toHaveCount(2, { timeout: 30_000 });
  await expect(editor.locator('.react-flow__edge')).toHaveCount(1);
  await editor.screenshot({ path: testInfo.outputPath('langflow-native-editor.png'), fullPage: true });
  await editor.close();
  const input = `AI Studio 原生 Langflow 联调 ${Date.now()}`;
  await page.getByRole('textbox', { name: '本次运行输入' }).fill(input);
  const receiptPromise = page.waitForResponse(response => response.url().endsWith('/api/langflow/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '运行 Langflow 流程', exact: true }).click();
  const receipt = await receiptPromise;
  expect(receipt.status()).toBe(202);
  const submittedBody = receipt.request().postDataJSON();
  const runId = (await receipt.json()).run.id;
  await expect.poll(async () => (await (await request.get(`${apiBase}/api/langflow/runs/${runId}`)).json()).run.status).toBe('succeeded');
  const completed = (await (await request.get(`${apiBase}/api/langflow/runs/${runId}`)).json()).run;
  expect(completed.provider).toBe('langflow'); expect(completed.flowId).toBe(echo.id); expect(completed.output).toBe(input);
  await expect(page.locator('.langflow-run-output pre')).toHaveText(input);
  const replay = await request.post(`${apiBase}/api/langflow/runs`, { data: submittedBody });
  expect(replay.status()).toBe(200); expect((await replay.json()).run.id).toBe(runId);
  const conflict = await request.post(`${apiBase}/api/langflow/runs`, { data: { ...submittedBody, input: 'changed' } });
  expect(conflict.status()).toBe(409);
  await page.screenshot({ path: testInfo.outputPath('langflow-studio-dark.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: new RegExp(`查看运行：${echoName}`) }).first().click();
  await expect(page.locator('.langflow-run-output pre')).toHaveText(input);
  await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('light');
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('langflow-studio-mobile-light.png'), fullPage: true });
});
