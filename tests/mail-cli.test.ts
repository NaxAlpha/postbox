import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createMailClient, mailboxOrigin, clean, accessToken } from '../scripts/mail-client.mjs';
import { loginMailbox } from '../scripts/mail-client.mjs';
import { executeMail } from '../scripts/mail-commands.mjs';
const address = {
  id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  email: 'test@example.test',
  enabled: 1,
  send_enabled: 1,
};
const id = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const draft = {
  id,
  folder: 'draft',
  status: 'draft',
  revision: 3,
  address_id: address.id,
  to_json: '["person@example.test"]',
  subject: 'Review me',
  text: 'Hello',
  attachments: [],
};
function context(handler = (_path: string, _method?: string, _body?: unknown): any => ({})) {
  const api = vi.fn(async (path, method, body) =>
    path === '/api/bootstrap' ? { addresses: [address] } : handler(path, method, body),
  );
  return { api, interactive: false, ask: vi.fn(), log: vi.fn() };
}
it('saves drafts without submitting and resolves configured sender', async () => {
  const c = context(() => ({ id, revision: 1 }));
  const result = await executeMail(
    'draft',
    {
      from: address.email,
      to: ['one@example.test,two@example.test'],
      subject: 'Review',
      body: 'Hello',
    },
    [],
    c,
  );
  expect(result.status).toBe('draft');
  expect(c.api.mock.calls[1]).toEqual([
    '/api/drafts',
    'POST',
    expect.objectContaining({
      addressId: address.id,
      to: ['one@example.test', 'two@example.test'],
      text: 'Hello',
    }),
  ]);
  expect(c.api.mock.calls.some(([p]) => p.endsWith('/send'))).toBe(false);
});
it('rejects unconfigured senders without a mutation', async () => {
  const c = context();
  await expect(executeMail('draft', { from: 'stranger@example.test' }, [], c)).rejects.toThrow(
    'configured mailbox',
  );
  expect(c.api).toHaveBeenCalledTimes(1);
});
it('requires explicit noninteractive send confirmation and only accepts drafts', async () => {
  const c = context(() => draft);
  await expect(executeMail('send', { id }, [], c)).rejects.toThrow('--yes');
  expect(c.api).toHaveBeenCalledTimes(2);
  const sent = context(() => ({ ...draft, folder: 'sent', status: 'queued' }));
  await expect(executeMail('send', { id, yes: true }, [], sent)).rejects.toThrow(
    'Only a saved draft',
  );
});
it('sends the reviewed revision and returns separate message/job IDs', async () => {
  const c = context((path) => (path.endsWith('/send') ? { id: 'job', status: 'queued' } : draft));
  const result = await executeMail('send', { id, yes: true }, [], c);
  expect(c.api.mock.calls[2]).toEqual([`/api/messages/${id}/send`, 'POST', { revision: 3 }]);
  expect(result).toEqual({ messageId: id, jobId: 'job', status: 'queued' });
});
it('interactive rejection never submits', async () => {
  const c = { ...context(() => draft), interactive: true, ask: vi.fn(async () => 'no') };
  expect(await executeMail('send', { id }, [], c)).toEqual({ cancelled: true, id });
  expect(c.api).toHaveBeenCalledTimes(2);
});
it('draft replacement requires explicit fields and preserves attachment/reply identity', async () => {
  const c = context((path) =>
    path.endsWith(id)
      ? { ...draft, reply_id: id, attachments: [{ id: 'file' }] }
      : { id, revision: 4 },
  );
  await expect(
    executeMail(
      'draft',
      { id, from: address.email, to: ['person@example.test'], subject: 'new' },
      [],
      c,
    ),
  ).rejects.toThrow('Updating requires');
  await executeMail(
    'draft',
    { id, from: address.email, to: ['person@example.test'], subject: 'new', body: '' },
    [],
    c,
  );
  expect(c.api.mock.calls.at(-1)).toEqual([
    '/api/drafts',
    'POST',
    expect.objectContaining({ revision: 3, attachments: ['file'], replyToMessageId: id, text: '' }),
  ]);
});
it('lists all addresses by default with explicit next page cursor', async () => {
  const c = context(() => ({ messages: [{ id }], total: 51, offset: 0 }));
  const result = await executeMail('list', {}, [], c);
  expect(c.api.mock.calls[1][0]).toBe('/api/messages?folder=inbox&offset=0');
  expect(result.nextOffset).toBe(1);
});
it('pins auth to configured origin, sends Access cookie and CSRF headers, never follows redirects', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
  await createMailClient('https://mail.example.test', { token: 'secret', fetchImpl })(
    '/api/drafts',
    'POST',
    { text: 'hello' },
  );
  const [url, options] = fetchImpl.mock.calls[0] as any;
  expect(url.origin).toBe('https://mail.example.test');
  expect(options.redirect).toBe('manual');
  expect(options.headers).toMatchObject({
    Cookie: 'CF_Authorization=secret',
    Origin: 'https://mail.example.test',
    'X-Postbox-Request': '1',
  });
  const denied = createMailClient('https://mail.example.test', {
    fetchImpl: async () =>
      new Response(null, { status: 302, headers: { Location: 'https://other.example' } }),
  });
  await expect(denied('/api/bootstrap')).rejects.toThrow('access denied');
});
it('never retries an ambiguous mutation or sends credentials to local preview', async () => {
  const fetchImpl = vi.fn(async () => {
    throw Error('secret internal error');
  });
  await expect(
    createMailClient('https://mail.example.test', { fetchImpl })('/api/drafts', 'POST', {}),
  ).rejects.toThrow('outcome is unknown');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const local = vi.fn(async () => Response.json({}));
  await createMailClient('http://127.0.0.1:5173', {
    local: true,
    token: 'secret',
    fetchImpl: local,
  })('/api/bootstrap');
  expect((local.mock.calls[0] as any)[1].headers.Cookie).toBeUndefined();
});
it('rejects unsafe local targets and strips terminal escape controls', () => {
  expect(() => mailboxOrigin({}, 'http://evil.example')).toThrow('loopback');
  expect(() => mailboxOrigin({}, 'http://localhost/a')).toThrow('loopback');
  expect(clean('\x1b]52;clipboard\x07hello\r')).not.toMatch(/[\x1b\x07\r]/);
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.sig`;
  expect(() => accessToken('https://example.test', { POSTBOX_ACCESS_TOKEN: token })).toThrow(
    'expired',
  );
});
it('command help and silent errors are machine readable without a project/auth', () => {
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ['scripts/postbox.mjs', ...args], { encoding: 'utf8' });
  expect(run('help', 'draft')).toContain('Creates a draft only');
  expect(JSON.parse(run('send', '--help', '--silent')).ok).toBe(true);
  try {
    run('send', '--silent', '--unexpected');
    throw Error('should fail');
  } catch (error: any) {
    expect(JSON.parse(error.stdout).ok).toBe(false);
  }
});
it('full subprocess CLI uses loopback API and emits exactly one JSON result', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/bootstrap'
          ? { addresses: [address] }
          : { messages: [draft], total: 1, offset: 0 },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as any).port;
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['scripts/postbox.mjs', 'list', `--local-url=http://127.0.0.1:${port}`, '--silent'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.on('error', reject);
      child.on('close', (code) => (code ? reject(Error(output)) : resolve(output)));
    });
    expect(JSON.parse(result)).toMatchObject({
      ok: true,
      command: 'list',
      data: { total: 1, nextOffset: null },
    });
    expect(result.trim().split('\n')).toHaveLength(1);
    expect(requests).toEqual(['/api/bootstrap', '/api/messages?folder=inbox&offset=0']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('caches an origin-bound Access session privately through cf without printing a token', () => {
  const previous = process.cwd(),
    dir = mkdtempSync(join(tmpdir(), 'postbox-auth-'));
  const origin = 'https://mail.example.test';
  const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.signature`;
  try {
    mkdirSync(join(dir, 'node_modules/cf/bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/cf/bin/cf'), `console.log(${JSON.stringify(token)});`);
    process.chdir(dir);
    loginMailbox(origin);
    expect(statSync('.postbox/access-token.json').mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync('.postbox/access-token.json', 'utf8')).origin).toBe(origin);
    expect(accessToken(origin, {})).toBe(token);
    expect(() => accessToken('https://other.example.test', {})).toThrow('postbox auth');
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
