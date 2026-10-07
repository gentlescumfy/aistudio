import { expect, test } from '@playwright/test';

function luminance(color: string) {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(foreground: string, background: string) {
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

test('dark/light theme persists and styles both workbench and settings', async ({ page }, testInfo) => {
  await page.goto('/');
  const selector = page.getByRole('combobox', { name: '界面主题', exact: true });
  await expect(selector).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '开始创作' })).toBeEnabled();
  await expect(page.getByRole('complementary', { name: '任务检查器' })).toBeVisible();
  const columns = await page.evaluate(() => ['.sidebar', '.main-shell', '.inspector'].map(selector => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return { left: box.left, right: box.right };
  }));
  expect(columns[0].right).toBeLessThanOrEqual(columns[1].left + 1);
  expect(columns[1].right).toBeLessThanOrEqual(columns[2].left + 1);
  await page.screenshot({ path: testInfo.outputPath('workspace-dark.png'), fullPage: true });
  await selector.selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(selector).toHaveValue('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('link', { name: '配置中心', exact: true }).click();
  await expect(page.getByLabel('默认生成数量')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('settings-light.png'), fullPage: true });
  await selector.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: testInfo.outputPath('settings-dark.png'), fullPage: true });
});

test('system theme follows OS changes and narrow layout retains theme controls', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const selector = page.getByRole('combobox', { name: '界面主题', exact: true });
  await selector.selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(selector).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile-dark.png'), fullPage: true });
});

test('light and dark active buttons and success labels retain readable contrast', async ({ page, request }, testInfo) => {
  const prompt = `主题对比度验收 ${Date.now()}`;
  const created = await request.post('http://127.0.0.1:4000/api/runs', {
    data: { templateId: 'brand-assets', inputs: { prompt, count: 1 }, idempotencyKey: `contrast-${Date.now()}` },
  });
  expect(created.status()).toBe(201);
  const run = (await created.json()).run;
  await expect.poll(async () => (await (await request.get(`http://127.0.0.1:4000/api/runs/${run.id}`)).json()).run.status).toBe('succeeded');
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(prompt) }).click();
  const selector = page.getByRole('combobox', { name: '界面主题', exact: true });
  for (const mode of ['light', 'dark']) {
    await selector.selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    for (const locator of [page.getByRole('button', { name: '开始创作' }), page.locator('.execution-section .status-succeeded'), page.getByRole('button', { name: '下载 mock-brand-1.svg', exact: true })]) {
      const colors = await locator.evaluate(element => {
        const styles = getComputedStyle(element);
        return { foreground: styles.color, background: styles.backgroundColor };
      });
      expect(contrast(colors.foreground, colors.background), `${mode} contrast: ${JSON.stringify(colors)}`).toBeGreaterThanOrEqual(4.5);
    }
    await page.screenshot({ path: testInfo.outputPath(`workspace-populated-${mode}.png`), fullPage: true });
  }
});

test('tablet inspector and status strip occupy separate rows', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: '任务检查器' })).toBeVisible();
  const boxes = await page.evaluate(() => {
    const inspector = document.querySelector('.inspector')!.getBoundingClientRect();
    const footer = document.querySelector('.status-strip')!.getBoundingClientRect();
    return { inspectorBottom: inspector.bottom, footerTop: footer.top, width: document.documentElement.scrollWidth };
  });
  expect(boxes.footerTop).toBeGreaterThanOrEqual(boxes.inspectorBottom);
  expect(boxes.width).toBeLessThanOrEqual(1024);
  await page.screenshot({ path: testInfo.outputPath('workspace-tablet.png'), fullPage: true });
});
