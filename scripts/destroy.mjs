import { existsSync, readFileSync } from 'node:fs';
import { cf, listPages } from './provider.mjs';
import { validateManifest, names } from './config.mjs';
import { setupState, savePrivate } from './setup.mjs';
const clone = (value) => JSON.parse(JSON.stringify(value));
function get(args, c) {
  try {
    return cf(args, c);
  } catch (error) {
    if (/404 Not Found/.test(error.stderr?.toString() || error.message || '')) return null;
    throw error;
  }
}
function sameDNS(a, b) {
  return ['id', 'name', 'type', 'content', 'priority', 'proxied', 'ttl'].every(
    (key) => b[key] === undefined || a[key] === b[key],
  );
}
function journal(c) {
  if (!existsSync('.postbox/setup.json'))
    return {
      version: 1,
      accountId: c.accountId,
      prefix: c.resourcePrefix,
      operations: [],
      dns: [],
      resources: [],
    };
  const s = setupState(c);
  if (
    s.version !== 1 ||
    !Array.isArray(s.operations) ||
    !Array.isArray(s.dns) ||
    !Array.isArray(s.resources)
  )
    throw new Error('Invalid domain setup journal');
  return s;
}
export function destructionPlan(c, { keepMail = false } = {}) {
  const install = existsSync('.postbox/install.json')
      ? validateManifest(JSON.parse(readFileSync('.postbox/install.json', 'utf8')), c)
      : null,
    state = journal(c);
  const pending = state.operations.filter((op) => !op.removedAt && op.status !== 'done');
  if (pending.length)
    throw new Error(
      'Domain journal has pending/uncertain operations. Reconcile their exact resources before destroying the installation.',
    );
  const domains = state.operations.filter(
    (op) => op.status === 'done' && !op.removedAt && ['sending', 'receiving'].includes(op.kind),
  );
  for (const op of domains) {
    if (!c.domains.some((d) => d.zoneId === op.zoneId && d.name === op.domain))
      throw new Error('Owned domain operation no longer matches configuration');
    if (op.kind === 'sending' && !op.result?.id)
      throw new Error('Sending domain ID is missing from the ownership journal');
    if (op.kind === 'receiving' && op.previousEnabled !== false)
      throw new Error(
        'Receiving domain ownership is ambiguous; record its original enabled state before removal',
      );
  }
  const dns = state.dns.filter((r) => r.owned && !r.removedAt);
  for (const record of dns) {
    if (
      !record.id ||
      !record.zoneId ||
      !record.name ||
      !record.type ||
      typeof record.content !== 'string'
    )
      throw new Error('Incomplete DNS ownership record');
  }
  const identities = state.resources.filter(
    (r) => r.kind === 'identityProvider' && r.owned && !r.removedAt,
  );
  for (const r of identities)
    if (!r.id || !r.name?.startsWith(c.resourcePrefix + '-'))
      throw new Error('Identity provider ownership is incomplete');
  return {
    accountId: c.accountId,
    prefix: c.resourcePrefix,
    permanentMailDeletion: !keepMail,
    resources:
      install?.resources.filter(
        (r) => r.owned && (!keepMail || !['database', 'bucket'].includes(r.kind)),
      ) || [],
    retainedMail: keepMail
      ? install?.resources.filter((r) => r.owned && ['database', 'bucket'].includes(r.kind)) || []
      : [],
    routes: install?.routes || [],
    domains: domains.map((op) => ({
      kind: op.kind,
      domain: op.domain,
      zoneId: op.zoneId,
      id: op.result?.id,
    })),
    dns: dns.map(({ id, zoneId, name, type }) => ({ id, zoneId, name, type })),
    identityProviders: identities.map(({ id, name }) => ({ id, name })),
    retainedShared: [
      'Cloudflare account and DNS zones',
      'Zero Trust organization',
      'Pre-existing domains, DNS, identity providers and unrelated routes',
      'Local configuration, manifests and backups',
    ],
    install,
    state,
  };
}
export function printDestruction(plan) {
  const { install, state, ...display } = plan;
  console.log(JSON.stringify(display, null, 2));
}
export function destroyInstallation(
  c,
  { apply = false, keepMail = false, confirmPrefix, installer } = {},
) {
  const plan = destructionPlan(c, { keepMail });
  printDestruction(plan);
  if (!apply) return plan;
  if (confirmPrefix !== c.resourcePrefix)
    throw new Error(
      'Destruction requires --confirm-prefix matching this installation. Mail deletion is permanent unless --keep-mail is selected.',
    );
  const state = plan.state,
    m = plan.install,
    routeIds = new Set(m?.routes.map((r) => r.id) || []);
  const activeDomains = state.operations.filter(
    (op) => op.status === 'done' && !op.removedAt && ['sending', 'receiving'].includes(op.kind),
  );
  // Preflight every setup resource before removing compute or mail. Shared or edited state blocks the whole operation.
  for (const d of plan.dns) {
    const recorded = state.dns.find((r) => r.id === d.id && r.zoneId === d.zoneId),
      live = get(['dns', 'records', 'get', d.id, '--zone', d.zoneId], c);
    if (live && !sameDNS(live, recorded))
      throw new Error(`DNS record changed since creation: ${d.name}. Refusing deletion.`);
  }
  for (const op of activeDomains) {
    const rules = listPages(['email-routing', 'rules', 'list-account', '--zone', op.zoneId], c);
    if (
      rules.some(
        (r) =>
          r.enabled &&
          !routeIds.has(r.id) &&
          r.matchers?.some(
            (x) =>
              x.type === 'all' || op.kind === 'receiving' || x.value?.endsWith('@' + op.domain),
          ),
      )
    )
      throw new Error(
        `Domain ${op.domain} has other active email routes; refusing to disable shared mail setup.`,
      );
    if (op.kind === 'sending') {
      const live = get(
        ['email-sending', 'subdomains', 'get', op.result.id, '--zone', op.zoneId],
        c,
      );
      if (live && live.name !== op.domain) throw new Error('Sending domain identity changed');
    }
    const beforeIds = new Set(op.before?.map((r) => r.id) || []),
      ownedIds = new Set(state.dns.filter((r) => r.zoneId === op.zoneId).map((r) => r.id));
    const dns = listPages(['dns', 'records', 'list', '--zone', op.zoneId], c);
    if (
      dns.some(
        (r) =>
          !beforeIds.has(r.id) &&
          !ownedIds.has(r.id) &&
          ((r.name === op.domain && ['MX', 'TXT'].includes(r.type)) ||
            r.name === `cf-bounce.${op.domain}` ||
            r.name === `cf-bounce._domainkey.${op.domain}` ||
            r.name === `_dmarc.${op.domain}`),
      )
    )
      throw new Error(`Domain ${op.domain} has unowned mail DNS; refusing automatic teardown.`);
  }
  const apps = plan.identityProviders.length
    ? listPages(['zero-trust', 'access', 'applications', 'list'], c)
    : [];
  for (const idp of plan.identityProviders) {
    const live = get(['zero-trust', 'identity-providers', 'get', idp.id], c);
    if (live && live.name !== idp.name) throw new Error('Identity provider name changed');
    if (
      apps.some(
        (a) =>
          a.id !== m?.resources.find((r) => r.kind === 'accessApplication')?.id &&
          (!a.allowed_idps?.length || a.allowed_idps.includes(idp.id)),
      )
    )
      throw new Error(
        'Owned identity provider is referenced by another application; refusing deletion',
      );
  }
  if (m?.resources.some((r) => r.owned)) {
    if (!installer) throw new Error('Installer is required for core resource removal');
    installer('uninstall', [
      '--apply',
      ...(!keepMail ? ['--delete-mail', `--confirm-prefix=${c.resourcePrefix}`] : []),
    ]);
  }
  // The Worker is now removed; Access was retained until that succeeded by the installer.
  const persist = () => savePrivate('.postbox/setup.json', state);
  for (const op of [...activeDomains].sort(
    (a, b) => (a.kind === 'sending' ? -1 : 1) - (b.kind === 'sending' ? -1 : 1),
  )) {
    if (op.kind === 'sending') {
      if (get(['email-sending', 'subdomains', 'get', op.result.id, '--zone', op.zoneId], c))
        cf(
          ['email-sending', 'subdomains', 'delete', op.result.id, '--zone', op.zoneId, '--force'],
          c,
        );
    } else {
      const zone = cf(['zones', 'get', '--zone', op.zoneId], c);
      cf(
        ['email-routing', 'disable', '--zone', op.zoneId, '--force'],
        c,
        op.domain === zone.name ? {} : { name: op.domain },
      );
    }
    op.removedAt = new Date().toISOString();
    persist();
  }
  for (const record of state.dns.filter((r) => r.owned && !r.removedAt)) {
    const live = get(['dns', 'records', 'get', record.id, '--zone', record.zoneId], c);
    if (live) {
      if (!sameDNS(live, record)) throw new Error('DNS changed during teardown; refusing deletion');
      cf(['dns', 'records', 'delete', record.id, '--zone', record.zoneId, '--force'], c);
    }
    record.removedAt = new Date().toISOString();
    record.owned = false;
    persist();
  }
  for (const resource of state.resources.filter(
    (r) => r.kind === 'identityProvider' && r.owned && !r.removedAt,
  )) {
    if (get(['zero-trust', 'identity-providers', 'get', resource.id], c))
      cf(['zero-trust', 'identity-providers', 'delete', resource.id, '--force'], c);
    resource.removedAt = new Date().toISOString();
    resource.owned = false;
    persist();
  }
  console.log(
    `Owned installation resources removed. ${keepMail ? 'D1/R2 mail retained.' : 'Mail storage permanently removed.'} Shared account infrastructure and local backups retained.`,
  );
  return plan;
}
