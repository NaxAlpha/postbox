import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../scripts/provider.mjs', () => ({
  cf: vi.fn(),
  listPages: vi.fn(),
  rows: (v: any) => (Array.isArray(v) ? v : v?.result || []),
}));
import { cf, listPages } from '../scripts/provider.mjs';
import { configSchema } from '../scripts/config.mjs';
import { dnsConflicts, inspectSetup, applyDomains, ensureIdentity } from '../scripts/setup.mjs';
import { selectedNumbers, wizard } from '../scripts/wizard.mjs';
const account = 'a'.repeat(32),
  zoneId = 'b'.repeat(32),
  zone = { id: zoneId, name: 'example.com', status: 'active', account: { id: account } };
const base = () =>
  configSchema.parse({
    ...JSON.parse(readFileSync(new URL('../mailbox.example.json', import.meta.url), 'utf8')),
    accountId: account,
    hostname: 'mail.example.com',
    access: { allowedUsers: ['owner@example.test'] },
    domains: [{ name: 'example.com', zoneId, sending: true, receiving: true, catchAll: false }],
    addresses: [{ email: 'hello@example.com', name: 'Hello' }],
  });
let dir: string, previous: string, dns: any[], senders: any[], enabled: boolean;
beforeEach(() => {
  previous = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'postbox-setup-'));
  process.chdir(dir);
  dns = [];
  senders = [];
  enabled = false;
  vi.clearAllMocks();
  vi.mocked(listPages).mockImplementation((args: string[]) =>
    args[0] === 'zones' ? [zone] : args[0] === 'dns' ? structuredClone(dns) : [],
  );
  vi.mocked(cf).mockImplementation((args: string[], _c: any, body: any) => {
    const s = args.join(' ');
    if (s === 'zero-trust organization get') return { auth_domain: 'team.cloudflareaccess.com' };
    if (s === 'zero-trust identity-providers list') return [];
    if (s === 'zero-trust identity-providers create') return { id: 'idp-new', ...body };
    if (s.startsWith('email-sending subdomains list')) return senders;
    if (s.startsWith('email-sending subdomains dns status')) return { status: 'ready' };
    if (s.startsWith('email-routing settings get')) return { enabled };
    if (s.startsWith('email-routing dns get')) return { records: [] };
    if (s.startsWith('email-routing enable')) {
      enabled = true;
      dns = [1, 2, 3].map((i) => ({
        id: `mx${i}`,
        name: body?.name || 'example.com',
        type: 'MX',
        content: `route${i}.mx.cloudflare.net`,
      }));
      return { enabled: true };
    }
    if (s.startsWith('email-sending subdomains create')) {
      const sender = { id: 'send-new', name: body.name };
      senders.push(sender);
      dns.push({
        id: 'dkim',
        name: `cf-bounce._domainkey.${body.name}`,
        type: 'TXT',
        content: 'public-key',
      });
      return sender;
    }
    throw new Error('Unexpected ' + s);
  });
});
afterEach(() => {
  process.chdir(previous);
  rmSync(dir, { recursive: true, force: true });
});
describe('DNS setup guards', () => {
  it('refuses another provider MX and an occupied web hostname', () => {
    const c = base();
    dns = [
      { name: 'example.com', type: 'MX', content: 'mx.other.test' },
      { name: 'mail.example.com', type: 'A', content: '192.0.2.1' },
    ];
    const plan = inspectSetup(c);
    expect(plan.conflicts.join(' ')).toContain('another mail provider');
    expect(plan.conflicts.join(' ')).toContain('already has DNS');
    expect(() => applyDomains(c, plan)).toThrow();
    expect(vi.mocked(cf).mock.calls.some((x) => x[0].includes('enable'))).toBe(false);
  });
  it('preserves existing SPF and DMARC policies during onboarding', () => {
    const errors = dnsConflicts(
      base().domains[0],
      zone,
      [{ name: 'example.com', type: 'TXT', content: 'v=spf1 include:other.test -all' }],
      'mail.example.com',
    );
    expect(errors[0]).toContain('SPF');
    dns = [{ name: '_dmarc.example.com', type: 'TXT', content: 'v=DMARC1; p=none' }];
    expect(inspectSetup(base()).conflicts.join(' ')).toContain('DMARC');
  });
  it('plans without writing and onboards once using exact domains and private journal IDs', () => {
    const c = base(),
      plan = inspectSetup(c);
    expect(plan.changes).toHaveLength(2);
    expect(existsSync('.postbox')).toBe(false);
    applyDomains(c, plan);
    const state = JSON.parse(readFileSync('.postbox/setup.json', 'utf8'));
    expect(state.dns.map((r: any) => r.id)).toEqual(['mx1', 'mx2', 'mx3', 'dkim']);
    expect(state.operations.every((op: any) => op.status === 'done')).toBe(true);
    applyDomains(c);
    expect(vi.mocked(cf).mock.calls.filter((x) => x[0].includes('enable'))).toHaveLength(1);
    expect(
      vi
        .mocked(cf)
        .mock.calls.filter((x) => x[0].slice(0, 3).join(' ') === 'email-sending subdomains create'),
    ).toHaveLength(1);
  });
  it('permits repairing unchanged DNS owned by this journal but blocks later edits', () => {
    const c = base();
    applyDomains(c);
    const path = '.postbox/setup.json',
      state = JSON.parse(readFileSync(path, 'utf8'));
    const policy = {
      id: 'dmarc-own',
      name: '_dmarc.example.com',
      type: 'TXT',
      content: 'v=DMARC1; p=reject',
    };
    dns.push(policy);
    state.dns.push({ ...policy, zoneId, owned: true });
    writeFileSync(path, JSON.stringify(state));
    const implementation = vi.mocked(cf).getMockImplementation()!;
    vi.mocked(cf).mockImplementation((args: any, c: any, b: any) =>
      args.join(' ').startsWith('email-sending subdomains dns status')
        ? { status: 'pending' }
        : implementation(args, c, b),
    );
    expect(inspectSetup(c).conflicts).toHaveLength(0);
    dns.find((r) => r.id === 'dmarc-own').content = 'v=DMARC1; p=none';
    expect(inspectSetup(c).conflicts.join(' ')).toContain('DMARC');
  });
  it('rereads DNS and refuses a conflict introduced after planning', () => {
    const c = base(),
      plan = inspectSetup(c);
    dns = [{ name: 'example.com', type: 'MX', content: 'foreign.test' }];
    expect(() => applyDomains(c, plan)).toThrow('another mail provider');
    expect(existsSync('.postbox')).toBe(false);
  });
  it('enables receiving subdomains with the full name and apex with an empty body', () => {
    const c = base();
    c.domains = [{ ...c.domains[0], name: 'in.example.com' }];
    c.addresses = [{ ...c.addresses[0], email: 'hello@in.example.com' }];
    applyDomains(c);
    expect(vi.mocked(cf).mock.calls.find((x) => x[0].includes('enable'))?.[2]).toEqual({
      name: 'in.example.com',
    });
  });
  it('rejects routes owned by other installations', () => {
    vi.mocked(listPages).mockImplementation((args: string[]) =>
      args[0] === 'zones'
        ? [zone]
        : args[0] === 'email-routing'
          ? [{ id: 'foreign', matchers: [{ value: 'hello@example.com' }] }]
          : [],
    );
    expect(inspectSetup(base()).conflicts.join(' ')).toContain('already reserves');
  });
  it('retains uncertain operation details when the provider fails', () => {
    const implementation = vi.mocked(cf).getMockImplementation()!;
    vi.mocked(cf).mockImplementation((args: any, c: any, b: any) => {
      if (args.includes('enable')) throw new Error('timeout');
      return implementation(args, c, b);
    });
    expect(() => applyDomains(base())).toThrow('timeout');
    const state = JSON.parse(readFileSync('.postbox/setup.json', 'utf8'));
    expect(state.operations[0].status).toBe('uncertain');
  });
  it('creates a restricted Cloudflare IdP and records ownership instead of requiring dashboard work', () => {
    const c = base();
    ensureIdentity(c);
    expect(c.access.identityProviderId).toBe('idp-new');
    const create = vi.mocked(cf).mock.calls.find((x) => x[0].at(-1) === 'create')!;
    expect(create[2].config.restrict_to_account_members).toBe(true);
    expect(JSON.parse(readFileSync('.postbox/setup.json', 'utf8')).resources[0].id).toBe('idp-new');
  });
});
describe('interactive configuration', () => {
  it('validates number lists', () => {
    expect(selectedNumbers('2,1,2', 2, true)).toEqual([1, 0]);
    for (const value of ['0', '3', '1x', '1,'])
      expect(() => selectedNumbers(value, 2, true)).toThrow();
  });
  it('collects selected domains, subdomains, addresses and independent web hostname', async () => {
    const answers = [
      '1',
      '1,2',
      'example.com',
      '1',
      'no',
      'in.second.test',
      '2',
      '2',
      'inbox',
      'my-postbox',
      'owner@example.test',
      'no',
      'hello,work',
      'support',
      'auto',
    ];
    const second = { ...zone, id: 'c'.repeat(32), name: 'second.test' };
    const c = await wizard({
      current: base(),
      ask: async (_label: string, _fallback: string, validate: any) => {
        const value = answers.shift()!;
        validate(value);
        return value;
      },
      log: () => {},
      accounts: () => [{ id: account, name: 'Owner' }],
      zones: () => [zone, second],
    });
    expect(c.hostname).toBe('inbox.second.test');
    expect(c.domains.map((d: any) => d.name)).toEqual(['example.com', 'in.second.test']);
    expect(c.domains[1].sending).toBe(false);
    expect(c.addresses.map((a: any) => a.email)).toEqual([
      'hello@example.com',
      'work@example.com',
      'support@in.second.test',
    ]);
    expect(c.access.mfa).toBe(false);
    expect(c.resourcePrefix).toBe('my-postbox');
    expect(answers).toHaveLength(0);
  });
});
