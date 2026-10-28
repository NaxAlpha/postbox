import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cf, rows, listPages } from './provider.mjs';
import { names, validateLive } from './config.mjs';

export function savePrivate(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}
export function setupState(c) {
  const file = '.postbox/setup.json';
  if (existsSync(file)) {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state.accountId !== c.accountId || state.prefix !== c.resourcePrefix)
      throw new Error('Domain setup journal belongs to another account/prefix');
    return state;
  }
  return {
    version: 1,
    accountId: c.accountId,
    prefix: c.resourcePrefix,
    operations: [],
    dns: [],
    resources: [],
  };
}
function persist(state) {
  mkdirSync('.postbox', { recursive: true, mode: 0o700 });
  savePrivate('.postbox/setup.json', state);
}
const routingMX = (value) => /^route[123]\.mx\.cloudflare\.net\.?$/i.test(value);
const at = (record, name) => record.name.toLowerCase().replace(/\.$/, '') === name;
export function dnsConflicts(domain, zone, records, hostname, ownedHost = false) {
  const errors = [];
  if (domain.receiving) {
    const mx = records.filter((r) => at(r, domain.name) && r.type === 'MX');
    if (mx.some((r) => !routingMX(r.content)))
      errors.push(
        `${domain.name} has another mail provider's MX records. Choose a separate receiving subdomain or migrate that provider explicitly.`,
      );
    if (records.some((r) => at(r, domain.name) && r.type === 'CNAME'))
      errors.push(`${domain.name} is a CNAME; receiving MX records cannot be added here.`);
    const spf = records.filter(
      (r) =>
        at(r, domain.name) && r.type === 'TXT' && r.content.replace(/"/g, '').startsWith('v=spf1'),
    );
    if (spf.length > 1 || spf.some((r) => !r.content.includes('include:_spf.mx.cloudflare.net')))
      errors.push(
        `${domain.name} has an existing SPF policy that needs an explicit merge before mail onboarding.`,
      );
  }
  if (domain.sending) {
    const bounce = `cf-bounce.${domain.name}`;
    if (
      records.some(
        (r) =>
          at(r, bounce) &&
          (r.type === 'CNAME' ||
            (r.type === 'MX' && !routingMX(r.content)) ||
            (r.type === 'TXT' &&
              r.content.replace(/"/g, '').startsWith('v=spf1') &&
              !r.content.includes('include:_spf.mx.cloudflare.net'))),
      )
    )
      errors.push(`${bounce} has conflicting bounce DNS records.`);
    const dmarc = records.filter((r) => at(r, `_dmarc.${domain.name}`) && r.type === 'TXT');
    if (dmarc.length > 1) errors.push(`${domain.name} has multiple DMARC policies.`);
  }
  if (hostname === zone.name || hostname.endsWith('.' + zone.name)) {
    if (records.some((r) => at(r, hostname)) && !ownedHost)
      errors.push(`${hostname} already has DNS records; choose an unused mailbox hostname.`);
    if (hostname === domain.name && domain.receiving)
      errors.push(
        'The browser hostname must differ from a receiving mail domain; use a mailbox subdomain such as mail.example.com.',
      );
  }
  return errors;
}

export function discoverAccounts() {
  return listPages(['accounts', 'list'], {});
}
export function discoverZones(accountId) {
  return listPages(['zones', 'list', '--account-id', accountId], { accountId }).filter(
    (z) => z.account?.id === accountId && z.status === 'active',
  );
}
export function inspectSetup(c) {
  validateLive(c);
  const journal = existsSync('.postbox/setup.json') ? setupState(c) : { dns: [] };
  const recorded = (record, zoneId) =>
    journal.dns.some(
      (saved) =>
        saved.owned &&
        saved.zoneId === zoneId &&
        saved.id === record.id &&
        saved.name === record.name &&
        saved.type === record.type &&
        saved.content === record.content,
    );
  const zones = discoverZones(c.accountId),
    hostZone = zones
      .filter((z) => c.hostname === z.name || c.hostname.endsWith('.' + z.name))
      .sort((a, b) => b.name.length - a.name.length)[0];
  if (!hostZone)
    throw new Error('Mailbox hostname must belong to an active DNS zone in the selected account');
  const existing = existsSync('.postbox/install.json')
    ? JSON.parse(readFileSync('.postbox/install.json', 'utf8'))
    : null;
  const ownedHost =
    existing?.accountId === c.accountId &&
    existing?.prefix === c.resourcePrefix &&
    existing?.resources?.some((r) => r.kind === 'worker' && r.owned && r.name === names(c).worker);
  const cache = new Map();
  const getDNS = (z) => {
    if (!cache.has(z.id)) cache.set(z.id, listPages(['dns', 'records', 'list', '--zone', z.id], c));
    return cache.get(z.id);
  };
  const domains = c.domains.map((d) => {
    const zone = zones.find(
      (z) => z.id === d.zoneId && (d.name === z.name || d.name.endsWith('.' + z.name)),
    );
    if (!zone)
      throw new Error(
        `Selected mail domain ${d.name} does not belong to its configured active account zone`,
      );
    if (d.catchAll && d.name !== zone.name)
      throw new Error('Catch-all is supported only for zone apex domains');
    const dns = getDNS(zone),
      conflicts = dnsConflicts(d, zone, dns, c.hostname, ownedHost);
    const sending = d.sending
      ? rows(cf(['email-sending', 'subdomains', 'list', '--zone', zone.id], c)).find(
          (x) => x.name === d.name,
        )
      : null;
    const status = sending
      ? cf(['email-sending', 'subdomains', 'dns', 'status', sending.id, '--zone', zone.id], c)
      : null;
    const settings = d.receiving
      ? cf(['email-routing', 'settings', 'get', '--zone', zone.id], c)
      : null;
    const receiving = d.receiving
      ? cf(
          [
            'email-routing',
            'dns',
            'get',
            '--zone',
            zone.id,
            ...(d.name === zone.name ? [] : ['--subdomain', d.name]),
          ],
          c,
        )
      : null;
    const mx = dns.filter((r) => at(r, d.name) && r.type === 'MX');
    const receiveReady =
      !!settings?.enabled && mx.length >= 3 && mx.every((r) => routingMX(r.content));
    const dmarc = dns.filter((r) => at(r, `_dmarc.${d.name}`) && r.type === 'TXT');
    // Never let onboarding/repair silently replace an existing authentication policy.
    if (
      d.sending &&
      (!sending || status?.status !== 'ready') &&
      dmarc.some((r) => !recorded(r, zone.id))
    )
      conflicts.push(
        `${d.name} already has a DMARC policy. Verify domain sending DNS without overwriting it before proceeding.`,
      );
    if (d.receiving && !receiveReady) {
      const spf = dns.filter(
        (r) =>
          at(r, d.name) && r.type === 'TXT' && r.content.replace(/"/g, '').startsWith('v=spf1'),
      );
      if (spf.some((r) => !recorded(r, zone.id)))
        conflicts.push(
          `${d.name} already has SPF; receiving onboarding requires review of that policy first.`,
        );
    }
    const rules = d.receiving
      ? listPages(['email-routing', 'rules', 'list-account', '--zone', zone.id], c)
      : [];
    for (const address of c.addresses.filter((a) => a.email.endsWith('@' + d.name))) {
      const rule = rules.find((r) => r.matchers?.some((x) => x.value === address.email));
      if (rule && !existing?.routes?.some((r) => r.id === rule.id))
        conflicts.push(
          `An existing route already reserves ${address.email}; it will not be replaced.`,
        );
    }
    if (
      d.catchAll &&
      rules.some((r) => r.enabled && r.matchers?.some((x) => x.type === 'all')) &&
      !existing?.routes?.some((r) => r.kind === 'catchAll' && r.zoneId === zone.id)
    )
      conflicts.push(`${d.name} already has an enabled catch-all; it will not be replaced.`);
    return {
      domain: d,
      zone,
      sendId: sending?.id,
      sendReady: status?.status === 'ready',
      receiveReady,
      routingEnabled: !!settings?.enabled,
      conflicts,
      dns,
      receivingDNS: receiving,
      changes: [
        ...(d.receiving &&
        d.catchAll &&
        !rules.some(
          (r) =>
            r.enabled &&
            r.matchers?.some((x) => x.type === 'all') &&
            r.actions?.some((a) => a.type === 'worker' && a.value?.includes(names(c).worker)),
        )
          ? ['Connect catch-all; unknown recipients remain rejected']
          : []),
        ...(d.receiving && !receiveReady
          ? ['Enable receiving and Cloudflare-managed MX/SPF/DKIM']
          : []),
        ...(d.sending && !sending
          ? ['Enable sending and Cloudflare-managed bounce/SPF/DKIM/DMARC']
          : d.sending && status?.status !== 'ready'
            ? ['Repair sending DNS']
            : []),
      ],
    };
  });
  const hostConflicts = dnsConflicts(
    { name: '', receiving: false, sending: false },
    hostZone,
    getDNS(hostZone),
    c.hostname,
    ownedHost,
  );
  const conflicts = [...new Set([...hostConflicts, ...domains.flatMap((d) => d.conflicts)])];
  return {
    hostname: c.hostname,
    hostZone: hostZone.id,
    resources: names(c),
    domains,
    conflicts,
    changes: domains.flatMap((d) => d.changes.map((change) => `${d.domain.name}: ${change}`)),
    dns: [...cache.entries()],
  };
}
export function printSetup(plan, log = console.log) {
  log(`Mailbox: https://${plan.hostname}`);
  log('Resources: ' + Object.values(plan.resources).join(', '));
  for (const d of plan.domains)
    log(
      `${d.domain.name}: receiving ${d.domain.receiving ? (d.receiveReady ? 'ready' : 'configure') : 'off'}; sending ${d.domain.sending ? (d.sendReady ? 'ready' : 'configure') : 'off'}`,
    );
  for (const change of plan.changes) log('  + ' + change);
  log(
    'Existing unrelated routes are preserved. Test/initial addresses receive literal routes unless catch-all was explicitly configured.',
  );
  for (const conflict of plan.conflicts) log('  BLOCKED: ' + conflict);
}
export function applyDomains(c, plan = inspectSetup(c)) {
  if (plan.conflicts.length) throw new Error(plan.conflicts.join('\n'));
  // Re-read the plan immediately before mutations; a saved plan is not authorization to overwrite new DNS.
  const current = inspectSetup(c);
  if (current.conflicts.length) throw new Error(current.conflicts.join('\n'));
  const state = setupState(c);
  for (const entry of current.domains) {
    const d = entry.domain;
    const ops = [];
    if (d.receiving && !entry.receiveReady)
      ops.push({
        kind: 'receiving',
        args: ['email-routing', 'enable', '--zone', d.zoneId],
        body: d.name === entry.zone.name ? {} : { name: d.name },
      });
    if (d.sending && !entry.sendId)
      ops.push({
        kind: 'sending',
        args: ['email-sending', 'subdomains', 'create', '--zone', d.zoneId],
        body: { name: d.name },
      });
    else if (d.sending && !entry.sendReady)
      ops.push({
        kind: 'sending-dns',
        args: ['email-sending', 'subdomains', 'dns', 'fix', entry.sendId, '--zone', d.zoneId],
      });
    for (const op of ops) {
      const before = listPages(['dns', 'records', 'list', '--zone', d.zoneId], c);
      const record = {
        id: randomUUID(),
        kind: op.kind,
        ...(op.kind === 'receiving'
          ? {
              previousEnabled:
                d.name === entry.zone.name ? entry.routingEnabled : entry.receiveReady,
            }
          : {}),
        domain: d.name,
        zoneId: d.zoneId,
        status: 'pending',
        before,
        createdAt: new Date().toISOString(),
      };
      state.operations.push(record);
      persist(state);
      try {
        record.result = cf(op.args, c, op.body);
        record.status = 'done';
      } catch (error) {
        record.status = 'uncertain';
        record.error = 'CLI operation failed; inspect current domain state before retrying';
        throw error;
      } finally {
        persist(state);
        const after = listPages(['dns', 'records', 'list', '--zone', d.zoneId], c),
          ids = new Set(before.map((x) => x.id));
        for (const r of after.filter((r) => !ids.has(r.id)))
          if (!state.dns.some((x) => x.id === r.id))
            state.dns.push({ ...r, zoneId: d.zoneId, owned: true, operationId: record.id });
        persist(state);
      }
    }
  }
  return state;
}
export function ensureIdentity(c) {
  const state = setupState(c);
  let org;
  try {
    org = cf(['zero-trust', 'organization', 'get'], c);
  } catch (error) {
    if (!/404 Not Found/.test(error.stderr?.toString() || '')) throw error;
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(c.access.teamDomain))
      throw new Error(
        'Set access.teamDomain to a unique TEAM.cloudflareaccess.com to create a Zero Trust organization through the CLI',
      );
    const pending = { kind: 'organization', name: c.access.teamDomain, status: 'pending' };
    state.resources.push(pending);
    persist(state);
    org = cf(['zero-trust', 'organization', 'create'], c, {
      auth_domain: c.access.teamDomain,
      name: c.resourcePrefix,
    });
    Object.assign(pending, { id: org.id || org.auth_domain, status: 'created', owned: true });
    persist(state);
  }
  if (c.access.teamDomain && c.access.teamDomain !== org.auth_domain)
    throw new Error('Configured Access team does not match the selected account');
  c.access.teamDomain = org.auth_domain;
  const providers = rows(cf(['zero-trust', 'identity-providers', 'list'], c));
  let provider = providers.find((p) =>
    c.access.identityProviderId ? p.id === c.access.identityProviderId : p.type === 'cloudflare',
  );
  if (!provider && c.access.identityProviderId)
    throw new Error('Configured identity provider was not found');
  if (!provider) {
    const name = `${c.resourcePrefix}-cloudflare`;
    if (providers.some((p) => p.name === name))
      throw new Error('Identity provider name is already in use');
    const pending = { kind: 'identityProvider', name, status: 'pending' };
    state.resources.push(pending);
    persist(state);
    provider = cf(['zero-trust', 'identity-providers', 'create'], c, {
      name,
      type: 'cloudflare',
      config: { restrict_to_account_members: true },
    });
    Object.assign(pending, { id: provider.id, status: 'created', owned: true });
    persist(state);
  }
  c.access.identityProviderId = provider.id;
  savePrivate('mailbox.config.json', c);
  return c;
}

export function recordHostDNS(c, plan) {
  const state = setupState(c),
    before = new Set((plan.dns.find(([id]) => id === plan.hostZone)?.[1] || []).map((r) => r.id));
  const records = listPages(['dns', 'records', 'list', '--zone', plan.hostZone], c);
  for (const record of records.filter(
    (r) =>
      r.name === c.hostname &&
      r.type === 'AAAA' &&
      r.content === '100::' &&
      r.proxied &&
      !before.has(r.id),
  )) {
    if (!state.dns.some((r) => r.id === record.id))
      state.dns.push({ ...record, zoneId: plan.hostZone, owned: true, kind: 'worker-hostname' });
  }
  persist(state);
}
