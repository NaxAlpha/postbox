import { chromium, expect } from '@playwright/test';
const origin = 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : process.platform === 'darwin'
      ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
      : {}),
  headless: true,
});
const page = await browser.newPage();
const mutationHeaders = { Origin: origin, 'X-Postbox-Request': '1' };
async function compose(text) {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  await page
    .locator('.mail-list')
    .getByText('A little inspiration for the weekend', { exact: true })
    .click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('dialog', { name: 'Compose message' }).waitFor();
  await page.getByLabel('Message body').fill(text);
}
try {
  await compose('The human reviewed this text');
  let changedId;
  await page.route('**/api/messages/*/send', async (route) => {
    const reviewed = route.request().postDataJSON();
    expect(Number.isInteger(reviewed.revision)).toBe(true);
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const message = await (await page.request.get(`${origin}/api/messages/${id}`)).json();
    const changed = await page.request.post(`${origin}/api/drafts`, {
      headers: mutationHeaders,
      data: {
        id,
        revision: message.revision,
        addressId: message.address_id,
        to: ['changed@example.test'],
        cc: [],
        bcc: [],
        subject: message.subject,
        text: 'Changed by another editor',
        attachments: message.attachments.map((f) => f.id),
        ...(message.reply_id ? { replyToMessageId: message.reply_id } : {}),
      },
    });
    expect(changed.status()).toBe(200);
    changedId = id;
    await route.continue();
  });
  const rejected = page.waitForResponse(
    (r) => r.url().endsWith('/send') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(
    page.getByText('Draft changed after review; review it again before sending', { exact: true }),
  ).toBeVisible();
  const kept = await (await page.request.get(`${origin}/api/messages/${changedId}`)).json();
  expect(kept.folder).toBe('draft');
  expect(kept.status).toBe('draft');
  await page.unroute('**/api/messages/*/send');
  await compose('Ordinary sending still works');
  const submitted = page.waitForResponse(
    (r) => r.url().endsWith('/send') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await submitted;
  expect(response.status()).toBe(200);
  expect(Number.isInteger(response.request().postDataJSON().revision)).toBe(true);
  const id = new URL(response.url()).pathname.split('/')[3];
  const undo = await page.request.post(`${origin}/api/messages/${id}/undo`, {
    headers: mutationHeaders,
    data: {},
  });
  expect(undo.status()).toBe(200);
  console.log(
    'PASS: browser rejects an interleaved recipient/body edit; normal send submits the saved revision. All mail local; successful submission undone.',
  );
} finally {
  await browser.close();
}
