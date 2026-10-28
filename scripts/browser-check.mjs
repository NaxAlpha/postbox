import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : process.platform === 'darwin'
      ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
      : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  if (await page.getByLabel('Switch to light mode', { exact: true }).count())
    await page.getByLabel('Switch to light mode', { exact: true }).click();
  await page.getByLabel('Switch to dark mode', { exact: true }).click();
  await page.reload();
  await page.getByLabel('Switch to light mode', { exact: true }).waitFor();
  if ((await page.locator('html').getAttribute('data-theme')) !== 'dark')
    throw new Error('Dark mode did not persist');
  await page.getByLabel('Switch to light mode', { exact: true }).click();
  await page
    .locator('.mail-list')
    .getByText('A little inspiration for the weekend', { exact: true })
    .click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('dialog', { name: 'Compose message' }).waitFor();
  const sending = await page.getByLabel('Sending address').inputValue();
  const boot = await (await page.request.get('http://127.0.0.1:5173/api/bootstrap')).json();
  const expected = boot.addresses.find((a) => a.email === 'hello@studio.example');
  if (sending !== expected.id) throw new Error('Reply uses wrong receiving identity');
  const dialog = page.getByRole('dialog', { name: 'Compose message' });
  await dialog.getByRole('button').first().focus();
  await page.keyboard.press('Shift+Tab');
  if (!(await dialog.evaluate((el) => el.contains(document.activeElement))))
    throw new Error('Keyboard focus escaped composer');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await page.getByRole('button', { name: 'Add address', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Mailbox settings' }).waitFor();
  await page.getByLabel('Display name').fill('Browser test');
  await page.getByLabel('Email address').fill(`browser-${Date.now()}@studio.example`);
  await page.getByRole('button', { name: 'Add address', exact: true }).last().click();
  await page.getByText('Address added', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByLabel('Color theme').selectOption('dark');
  if ((await page.locator('html').getAttribute('data-theme')) !== 'dark')
    throw new Error('Appearance dark mode failed');
  await page.getByLabel('Color theme').selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Color theme').selectOption('light');
  await page.getByLabel('Close settings').click();
  await mkdir('test-results/browser', { recursive: true });
  await page.getByLabel('Dismiss notification').click();
  await page.getByRole('button', { name: 'All inboxes', exact: true }).click();
  await page
    .locator('.mail-list')
    .getByText('A little inspiration for the weekend', { exact: true })
    .click();
  await page.locator('.reader-scroll').evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/browser/desktop.png', fullPage: true });
  await page.getByLabel('Switch to dark mode', { exact: true }).click();
  await page.getByRole('button', { name: 'Formatted view', exact: true }).last().click();
  await expect(page.locator('.message-row.selected')).toHaveCSS(
    'background-color',
    'rgb(33, 28, 47)',
  );
  await expect(page.frameLocator('.html-message').locator('body')).toHaveCSS(
    'background-color',
    'rgb(35, 35, 35)',
  );
  await page.screenshot({ path: 'test-results/browser/dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Back to list').click();
  await page.getByLabel('Open menu').click();
  await page.getByRole('button', { name: 'All inboxes', exact: true }).click();
  await page.screenshot({ path: 'test-results/browser/mobile-dark.png', fullPage: true });
  await page.getByLabel('Switch to light mode', { exact: true }).click();
  await page.screenshot({ path: 'test-results/browser/mobile.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) throw new Error('Mobile viewport has horizontal overflow');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'PASS: browser reply identity, draft save, explicit address creation, responsive viewport, no page errors.',
  );
} finally {
  await browser.close();
}
