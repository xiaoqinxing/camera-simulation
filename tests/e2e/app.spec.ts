import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

test('离线页面加载、参数交互、配置往返及导出', async ({ page, context }) => {
  const external: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  const allowedOrigin = new URL(process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4173').origin;
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  const isExternal = (address: string | URL) => {
    const url = new URL(address);
    return url.origin !== allowedOrigin && url.protocol !== 'data:' && url.protocol !== 'blob:';
  };
  page.on('request', request => { if (isExternal(request.url())) external.push(request.url()); });
  // Routing same-origin large downloads via the test proxy can stall on slow WAN links.
  // Intercept only off-origin requests, keeping same-origin streaming unchanged.
  await context.route(isExternal, route => route.abort());
  await page.goto('/');
  await expect(page.getByText('写实人物已就绪')).toBeVisible({ timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('12px "Noto Sans SC Variable"', '镜界摄像机'))).toBeTruthy();
  await expect(page.getByText('87.7°', { exact: true })).toBeVisible();
  await expect(page.getByText('56.7°', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '镜头成像' }).click();
  const focal = page.getByRole('spinbutton', { name: '实际焦距' });
  await focal.fill('0'); await focal.press('Enter');
  await expect(page.getByRole('alert')).toContainText('0.5–50'); await expect(focal).toHaveValue('4');
  await focal.fill('8'); await focal.press('Enter');
  await expect(page.getByText('51.3°', { exact: true })).toBeVisible();
  const hfov = page.getByRole('spinbutton', { name: '画面水平视场角' });
  await hfov.fill('87.6617'); await hfov.press('Enter');
  await expect(focal).toHaveValue('4');
  await focal.fill('8'); await focal.press('Enter');
  await page.getByRole('button', { name: /人物/ }).first().click();
  const distance = page.getByRole('spinbutton', { name: '人物水平距离' });
  await distance.fill('4'); await distance.press('Enter');
  await expect(page.getByText('4.00 m', { exact: true }).first()).toBeVisible();
  const saved = page.waitForEvent('download'); await page.getByRole('button', { name: '保存配置' }).click();
  const savedFile = await saved, path = await savedFile.path(); expect(path).toBeTruthy();
  const json = JSON.parse(await fs.readFile(path!, 'utf8')); expect(json.lens.focalLength).toBe(8);
  const oldDistance = Number((await page.locator('.metric').nth(0).locator('strong').innerText()).replace(/[^\d.-]/g, ''));
  const oldPortrait = Number((await page.locator('.metric').nth(1).locator('strong').innerText()).replace('%', ''));
  expect(oldPortrait).toBeGreaterThan(0);
  await distance.fill('5'); await distance.press('Enter');
  await expect(page.locator('.metric').nth(0)).toContainText('5.00');
  await expect.poll(async () => Number((await page.locator('.metric').nth(0).locator('strong').innerText()).replace(/[^\d.-]/g, ''))).toBeGreaterThan(oldDistance);
  await expect.poll(async () => Number((await page.locator('.metric').nth(1).locator('strong').innerText()).replace('%', ''))).toBeLessThan(oldPortrait);
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'config.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await expect(page.getByText('配置已加载。')).toBeVisible();
  await expect(page.getByText('8.00 mm', { exact: true })).toBeVisible();
  const shot = page.waitForEvent('download'); await page.getByRole('button', { name: '导出截图' }).click();
  const screenshot = await shot; expect(screenshot.suggestedFilename()).toMatch(/\.png$/);
  const bytes = await fs.readFile((await screenshot.path())!); expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.readUInt32BE(16)).toBe(1920); expect(bytes.readUInt32BE(20)).toBe(1080);
  const text = page.waitForEvent('download'); await page.getByRole('button', { name: '参数摘要' }).click();
  expect((await text).suggestedFilename()).toMatch(/\.txt$/);
  expect(external).toEqual([]); expect(failed).toEqual([]); expect(errors).toEqual([]);
});

test('墙面快捷机位默认屏幕墙并可切换', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('写实人物已就绪')).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: '摄像机', exact: false }).first().click();
  const x = page.getByRole('spinbutton', { name: '摄像机位置 X' });
  const z = page.getByRole('spinbutton', { name: '摄像机位置 Z' });
  const y = page.getByRole('spinbutton', { name: '安装高度 Y' });
  const screen = page.getByRole('button', { name: '屏幕墙', exact: true });
  const opposite = page.getByRole('button', { name: '对面墙', exact: true });
  await expect(screen).toHaveAttribute('aria-pressed', 'true');
  await expect(x).toHaveValue('0'); await expect(z).toHaveValue('2.35'); await expect(y).toHaveValue('2.7');

  await opposite.click();
  await expect(opposite).toHaveAttribute('aria-pressed', 'true'); await expect(screen).toHaveAttribute('aria-pressed', 'false');
  await expect(x).toHaveValue('0'); await expect(z).toHaveValue('-2.35'); await expect(y).toHaveValue('2.7');

  await page.getByRole('button', { name: '左墙', exact: true }).click();
  await expect(x).toHaveValue('-1.85'); await expect(z).toHaveValue('0');
  await page.getByRole('button', { name: '右墙', exact: true }).click();
  await expect(x).toHaveValue('1.85'); await expect(z).toHaveValue('0');

  await x.fill('0.5'); await x.press('Enter');
  for (const name of ['屏幕墙', '对面墙', '左墙', '右墙']) await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');

  await page.getByRole('button', { name: '会议室', exact: false }).click();
  const length = page.getByRole('spinbutton', { name: '房间长度' }); await length.fill('6'); await length.press('Enter');
  await page.getByRole('button', { name: '摄像机', exact: false }).first().click();
  await screen.click();
  await expect(z).toHaveValue('2.85'); await expect(screen).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '恢复相机' }).click();
  await expect(screen).toHaveAttribute('aria-pressed', 'true'); await expect(x).toHaveValue('0'); await expect(z).toHaveValue('2.85'); await expect(y).toHaveValue('2.7');
});

test('房间变化、4:3 裁切、手动角度和畸变恢复', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('写实人物已就绪')).toBeVisible({ timeout: 60000 });
  const length = page.getByRole('spinbutton', { name: '房间长度' });
  await length.fill('6'); await length.press('Enter');
  await expect(page.getByText('6 × 4 × 2.8 m')).toBeVisible();
  await page.getByRole('button', { name: '输出', exact: false }).click();
  await page.getByRole('button', { name: '4:3', exact: true }).click();
  await expect(page.getByText('71.5°', { exact: true })).toBeVisible();
  const box = await page.locator('[aria-label="摄像机画面视图"]').boundingBox();
  expect(box!.width / box!.height).toBeCloseTo(4 / 3, 2);
  await page.getByRole('button', { name: '摄像机', exact: false }).first().click();
  const yaw = page.getByRole('spinbutton', { name: '水平旋转角' });
  await yaw.fill('35'); await yaw.press('Enter');
  await page.getByRole('button', { name: /人物/ }).first().click();
  const px = page.getByRole('spinbutton', { name: '人物位置 X' }); await px.fill('-1'); await px.press('Enter');
  await page.getByRole('button', { name: '摄像机', exact: false }).first().click();
  await expect(page.getByRole('spinbutton', { name: '水平旋转角' })).toHaveValue('35');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.getByRole('button', { name: '镜头成像' }).click();
  const shot = async () => {
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: '导出截图' }).click();
    return fs.readFile((await (await event).path())!);
  };
  const baseline = await shot();
  await page.getByRole('button', { name: '摄像机', exact: false }).first().click();
  const currentYaw = page.getByRole('spinbutton', { name: '水平旋转角' }); await currentYaw.fill('0'); await currentYaw.press('Enter');
  const currentPitch = page.getByRole('spinbutton', { name: '俯仰角' }); await currentPitch.fill('0'); await currentPitch.press('Enter');
  await expect(page.locator('.metric').nth(1).locator('strong')).toHaveText('—');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await page.getByRole('button', { name: '镜头成像' }).click();
  const k = page.getByRole('spinbutton', { name: '径向畸变 k1' }); await k.fill('0.1'); await k.press('Enter');
  await page.getByRole('switch', { name: '镜头畸变' }).click();
  await expect(page.getByText(/畸变开启 · k1 0\.1/)).toBeVisible();
  // Derived readouts appear in both the lens panel and the optics detail card.
  await expect(page.getByText('+12.13%', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('+4.61%', { exact: true }).first()).toBeVisible();
  const distorted = await shot(); expect(distorted.equals(baseline)).toBe(false);
  await k.fill('-0.1'); await k.press('Enter');
  const barrel = await shot(); expect(barrel.equals(baseline)).toBe(false); expect(barrel.equals(distorted)).toBe(false);
  await page.getByRole('switch', { name: '镜头畸变' }).click();
  const restored = await shot(); expect(restored.equals(baseline)).toBe(true);
});

test('4K 导出与低分辨率预览解耦', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/'); await expect(page.getByText('写实人物已就绪')).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: '输出', exact: false }).click();
  await page.getByRole('button', { name: '4K UHD', exact: true }).click();
  await expect(page.getByText('导出 3840 × 2160')).toBeVisible();
  const box = await page.locator('[aria-label="摄像机画面视图"]').boundingBox();
  expect(box!.width).toBeLessThan(1920);
  expect(box!.height).toBeLessThan(1080);
  const shot = page.waitForEvent('download'); await page.getByRole('button', { name: '导出截图' }).click();
  const bytes = await fs.readFile((await (await shot).path())!);
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.readUInt32BE(16)).toBe(3840); expect(bytes.readUInt32BE(20)).toBe(2160);
  expect(bytes.length).toBeGreaterThan(100000);
});

test('左下角显示版本号并可查看版本历史', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: /查看版本历史/ });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText(/^v\d+\.\d+\.\d+/);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '版本历史' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('每次提交自动递增一次');
  await expect(dialog.locator('.version-list li').first()).toContainText('当前');
  expect(await dialog.locator('.version-list li').count()).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
