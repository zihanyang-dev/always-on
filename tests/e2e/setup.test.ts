import { expect, test } from '@playwright/test';

test('shows real service readiness and stays usable on the target viewport', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '从这里，开始持续工作。' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('连接就绪');
  await expect(page.getByRole('button', { name: '重新检查' })).toBeEnabled();
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByRole('status')).toHaveText('连接就绪');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('setup.png'), fullPage: true });
});

test('keeps the checking badge neutral until readiness finishes', async ({ page }) => {
  const release = Promise.withResolvers<void>();
  await page.route('**/api/health/ready', async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText('正在检查');
    await expect(page.getByRole('status')).not.toHaveClass(/status-ready/);
  } finally {
    release.resolve();
  }
  await expect(page.getByRole('status')).toHaveText('连接就绪');
  await expect(page.getByRole('status')).toHaveClass(/status-ready/);
});

test('recovers from unavailable backing services after checking again', async ({ page }) => {
  await page.route('**/api/health/ready', (route) =>
    route.fulfill({
      status: 503,
      json: { status: 'unavailable', checks: { database: 'down', redis: 'up' } },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('等待服务');
  await page.unroute('**/api/health/ready');
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByRole('status')).toHaveText('连接就绪');
});

test('shows a translated error when the service cannot be reached', async ({ page }) => {
  await page.route('**/api/health/ready', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('连接中断');
  await expect(page.getByRole('alert')).toHaveText(
    '服务暂时无法连接。确认后端已经启动，再重新检查。',
  );
});

test.describe('English browser preference', () => {
  test.use({ locale: 'en-US' });

  test('switches languages and remembers the explicit choice across reloads', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'A place for work to keep going.' }),
    ).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Connections ready');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('setup-en.png'), fullPage: true });
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh');
    await expect(page.getByRole('heading', { name: '从这里，开始持续工作。' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.reload();
    await expect(page.getByRole('combobox', { name: '语言' })).toHaveValue('zh');
    await page.getByRole('combobox', { name: '语言' }).selectOption('en');
    await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });
});

test.describe('Unsupported browser preference', () => {
  test.use({ locale: 'fr-FR' });

  test('falls back to English', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
