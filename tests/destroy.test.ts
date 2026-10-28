import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../scripts/provider.mjs', () => ({ cf: vi.fn(), listPages: vi.fn() }));
import { cf, listPages } from '../scripts/provider.mjs';
import { configSchema, names } from '../scripts/config.mjs';
import { destructionPlan, destroyInstallation } from '../scripts/destroy.mjs';
let root: string,
  previous: string,
  c: any,
  dns: any[],
  rules: any[],
  apps: any[],
  events: string[],
  removed: Set<string>;
const zoneId = 'b'.repeat(32);
beforeEach(() => {
  previous = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'postbox-destroy-'));
  process.chdir(root);
  mkdirSync('.postbox');
  c = configSchema.parse({
    ...JSON.parse(readFileSync(new URL('../mailbox.example.json', import.meta.url), 'utf8')),
    accountId: 'a'.repeat(32),
    resourcePrefix: 'owned-box',
    hostname: 'mail.example.com',
    domains: [{ name: 'example.com', zoneId, sending: true, receiving: true, catchAll: true }],
  });
  const n = names(c),
    resources = Object.entries(n).map(([kind, name], i) => ({
      kind,
      name,
      id: kind === 'database' ? 'db' : `res-${i}`,
      owned: true,
      accountId: c.accountId,
      installId: 'install',
    }));
  writeFileSync(
    '.postbox/install.json',
    JSON.stringify({
      version: 1,
      installId: 'install',
      prefix: c.resourcePrefix,
      accountId: c.accountId,
      databaseId: 'db',
      resources,
      routes: [{ id: 'our-rule', zoneId, kind: 'literal' }],
    }),
  );
  dns = [
    {
      id: 'owned-dns',
      zoneId,
      name: 'example.com',
      type: 'MX',
      content: 'route1.mx.cloudflare.net',
      owned: true,
    },
  ];
  rules = [];
  apps = [];
  events = [];
  removed = new Set();
  writeFileSync(
    '.postbox/setup.json',
    JSON.stringify({
      version: 1,
      accountId: c.accountId,
      prefix: c.resourcePrefix,
      operations: [
        {
          kind: 'receiving',
          status: 'done',
          domain: 'example.com',
          zoneId,
          before: [],
          previousEnabled: false,
        },
        {
          kind: 'sending',
          status: 'done',
          domain: 'example.com',
          zoneId,
          before: [],
          result: { id: 'sending' },
        },
      ],
      dns,
      resources: [
        { kind: 'identityProvider', id: 'idp', name: 'owned-box-cloudflare', owned: true },
      ],
    }),
  );
  vi.clearAllMocks();
  vi.mocked(listPages).mockImplementation((a: string[]) =>
    a[0] === 'email-routing'
      ? rules
      : a[0] === 'dns'
        ? dns.filter((r) => !removed.has(r.id))
        : apps,
  );
  vi.mocked(cf).mockImplementation((a: string[]) => {
    events.push(a.join(' '));
    if (a.includes('delete') || a.includes('disable')) {
      removed.add(a[2]);
      return null;
    }
    if (a[0] === 'zones') return { name: 'example.com', account: { id: c.accountId } };
    if (a[0] === 'dns') return removed.has(a[3]) ? null : dns.find((r) => r.id === a[3]);
    if (a[0] === 'email-sending')
      return removed.has('sending') ? null : { name: 'example.com', id: 'sending' };
    if (a[0] === 'zero-trust')
      return removed.has('idp') ? null : { id: 'idp', name: 'owned-box-cloudflare' };
    throw Error('Unexpected ' + a.join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(previous);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const installer = vi.fn((_command: string, args: string[]) => {
  events.push('core removed');
  const p = '.postbox/install.json',
    m = JSON.parse(readFileSync(p, 'utf8'));
  for (const r of m.resources)
    if (args.includes('--delete-mail') || !['database', 'bucket'].includes(r.kind)) r.owned = false;
  writeFileSync(p, JSON.stringify(m));
});
it('previews all owned resources including mail, DNS, domain onboarding, and IdP without API calls', () => {
  const p = destructionPlan(c);
  expect(p.permanentMailDeletion).toBe(true);
  expect(p.resources).toHaveLength(7);
  expect(p.domains).toHaveLength(2);
  expect(p.dns).toHaveLength(1);
  expect(p.identityProviders).toHaveLength(1);
  expect(cf).not.toHaveBeenCalled();
  destroyInstallation(c, { installer });
  expect(cf).not.toHaveBeenCalled();
  expect(installer).not.toHaveBeenCalled();
});
it('requires exact prefix before any provider calls', () => {
  expect(() => destroyInstallation(c, { apply: true, confirmPrefix: 'wrong', installer })).toThrow(
    'confirm-prefix',
  );
  expect(cf).not.toHaveBeenCalled();
});
it('removes compute/storage before owned onboarding/DNS/identity, recording completion', () => {
  destroyInstallation(c, { apply: true, confirmPrefix: c.resourcePrefix, installer });
  expect(installer).toHaveBeenCalledWith('uninstall', [
    '--apply',
    '--delete-mail',
    '--confirm-prefix=owned-box',
  ]);
  expect(events.indexOf('core removed')).toBeLessThan(
    events.findIndex((e) => e.includes('subdomains delete')),
  );
  const s = JSON.parse(readFileSync('.postbox/setup.json', 'utf8'));
  expect(s.operations.every((r: any) => r.removedAt)).toBe(true);
  expect(s.dns.every((r: any) => !r.owned)).toBe(true);
  expect(s.resources[0].owned).toBe(false);
});
it('keeps mail only when requested explicitly', () => {
  destroyInstallation(c, {
    apply: true,
    keepMail: true,
    confirmPrefix: c.resourcePrefix,
    installer,
  });
  expect(installer).toHaveBeenCalledWith('uninstall', ['--apply']);
  expect(destructionPlan(c, { keepMail: true }).retainedMail).toHaveLength(2);
});
it('refuses edited DNS before deleting core resources', () => {
  dns[0].content = 'foreign.mx.test';
  expect(() =>
    destroyInstallation(c, { apply: true, confirmPrefix: c.resourcePrefix, installer }),
  ).toThrow('DNS record changed');
  expect(installer).not.toHaveBeenCalled();
});
it('refuses domains that gained foreign active mail routes', () => {
  rules = [{ id: 'foreign', enabled: true, matchers: [{ value: 'someone@example.com' }] }];
  expect(() =>
    destroyInstallation(c, { apply: true, confirmPrefix: c.resourcePrefix, installer }),
  ).toThrow('other active email routes');
  expect(installer).not.toHaveBeenCalled();
});
it('refuses identity providers shared by another app', () => {
  apps = [{ id: 'foreign', allowed_idps: ['idp'] }];
  expect(() =>
    destroyInstallation(c, { apply: true, confirmPrefix: c.resourcePrefix, installer }),
  ).toThrow('another application');
  expect(installer).not.toHaveBeenCalled();
});
it('preserves all setup resources if core removal fails', () => {
  expect(() =>
    destroyInstallation(c, {
      apply: true,
      confirmPrefix: c.resourcePrefix,
      installer: () => {
        throw Error('Worker still exists');
      },
    }),
  ).toThrow('Worker still exists');
  expect(events.some((e) => e.includes(' delete ') || e.includes('disable'))).toBe(false);
});
it('refuses an uncertain creation journal and foreign account', () => {
  const p = '.postbox/setup.json',
    s = JSON.parse(readFileSync(p, 'utf8'));
  s.operations[0].status = 'uncertain';
  writeFileSync(p, JSON.stringify(s));
  expect(() => destructionPlan(c)).toThrow('uncertain');
  s.accountId = 'c'.repeat(32);
  writeFileSync(p, JSON.stringify(s));
  expect(() => destructionPlan(c)).toThrow('another account');
});
it('can resume after completed removal without deleting again', () => {
  destroyInstallation(c, { apply: true, confirmPrefix: c.resourcePrefix, installer });
  events = [];
  destroyInstallation(c, { apply: true, confirmPrefix: c.resourcePrefix, installer });
  expect(events.some((e) => e.includes('delete') || e.includes('disable'))).toBe(false);
});
