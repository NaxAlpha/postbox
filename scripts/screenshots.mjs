import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const origin = 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : process.platform === 'darwin'
      ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
      : {}),
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
try {
  const response = await page.request.get(`${origin}/api/bootstrap`);
  const bootstrap = await response.json();
  if (
    !bootstrap.local ||
    bootstrap.addresses.length !== 3 ||
    !bootstrap.addresses.every((a) => a.email.endsWith('@studio.example'))
  )
    throw new Error(
      'Use a fresh isolated sample preview: POSTBOX_LOCAL_STATE=.postbox/screenshots npm run dev',
    );
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  await page
    .locator('.mail-list')
    .getByText('A little inspiration for the weekend', { exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'A little inspiration for the weekend', exact: true, level: 2 })
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/images', { recursive: true });
  await page.screenshot({ path: 'docs/images/desktop.png', fullPage: true });
  await page.getByLabel('Switch to dark mode', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'docs/images/dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Back to list').click();
  await page.screenshot({ path: 'docs/images/mobile-dark.png', fullPage: true });
  await page.getByLabel('Switch to light mode', { exact: true }).click();
  await page.screenshot({ path: 'docs/images/mobile.png', fullPage: true });
  console.log('Captured retina screenshots from isolated synthetic mail.');
} finally {
  await browser.close();
}
