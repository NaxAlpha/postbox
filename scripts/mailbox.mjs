import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  chmodSync,
  readdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createBucketIdentity,
  verifyBucketIdentity,
  reconcileLegacyBucket,
  BUCKET_MARKER,
} from './bucket-ownership.mjs';
import { exportMail, restoreMail } from './backup.mjs';
import { cf, rows, listPages, rawSql } from './provider.mjs';
import { configSchema, names, validateLive, validateManifest } from './config.mjs';
const command = process.argv[2] || 'help',
  flags = new Set(process.argv.slice(3));
const path = resolve('mailbox.config.json'),
  state = resolve('.postbox/install.json'),
  cli = resolve('node_modules/cf/bin/cf');
const help = `Postbox installation tools\n\n  npm run mailbox -- reconcile-bucket --audit-id=UUID [--apply --confirm-prefix=PREFIX]\n  npm run mailbox -- init                 Create private editable configuration\n  npm run mailbox -- plan                 Show derived resources without API calls\n  npm run mailbox -- install --apply      Provision Access/storage and deploy\n  npm run mailbox -- connect-mail --apply Add owned email routes after onboarding\n  npm run mailbox -- register-events --apply --subscription=ID
                                          Own a manually created sending event subscription
  npm run mailbox -- doctor               Inspect deployed resources and security\n  npm run mailbox -- upgrade --apply      Apply schema/config and redeploy\n  npm run mailbox -- export               Export D1 and all private R2 objects
  npm run mailbox -- restore --backup=PATH/backup.json [--apply]
                                          Restore into a new empty installation\n  npm run mailbox -- uninstall            Show removal plan; preserve mail by default\n  npm run mailbox -- uninstall --apply    Remove owned app/resources; retain D1/R2\n  npm run mailbox -- uninstall --apply --delete-mail --confirm-prefix=PREFIX\n                                          Permanently delete mail too\n\nUse cf auth login before account operations. No secrets are stored in configuration or manifest.`;
function load() {
  if (!existsSync(path)) throw new Error('Run npm run mailbox -- init first');
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
function writeConfig(c) {
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
function save(m) {
  mkdirSync('.postbox', { recursive: true, mode: 0o700 });
  const tmp = state + '.tmp';
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, state);
}
function record(m, c, kind, id, name, metadata = {}) {
  m.resources.push({
    kind,
    id,
    name,
    owned: true,
    accountId: c.accountId,
    installId: m.installId,
    ...metadata,
  });
  save(m);
  return id;
}
function owned(m, kind) {
  return m.resources.find((r) => r.kind === kind && r.owned);
}
async function install(c, m, upgrade = false) {
  const n = validateLive(c);
  const org = cf(['zero-trust', 'organization', 'get'], c);
  if (!org?.auth_domain)
    throw new Error('Complete Zero Trust Free onboarding in your account, then rerun install');
  if (c.access.teamDomain && c.access.teamDomain !== org.auth_domain)
    throw new Error('Access teamDomain differs from this account’s Zero Trust organization');
  c.access.teamDomain = org.auth_domain;
  const providers = rows(cf(['zero-trust', 'identity-providers', 'list'], c));
  const idp = providers.find((p) =>
    c.access.identityProviderId ? p.id === c.access.identityProviderId : p.type === 'cloudflare',
  );
  if (!idp)
    throw new Error(
      'Configure the Cloudflare identity provider in Zero Trust or specify identityProviderId',
    );
  c.access.identityProviderId = idp.id;
  if (c.access.mfa && !org.mfa_config?.allowed_authenticators?.length)
    throw new Error(
      'Enable independent MFA in your Zero Trust organization before selecting access.mfa=true',
    );
  // Refuse to adopt pre-existing same-name resources. A matching prefix is not proof of ownership.
  if (
    !owned(m, 'database') &&
    rows(cf(['d1', 'list', '--name', n.database], c)).some((r) => r.name === n.database)
  )
    throw new Error('Database name already exists; select another prefix');
  if (
    !owned(m, 'bucket') &&
    rows(cf(['r2', 'buckets', 'list', '--name-contains', n.bucket], c)).some(
      (r) => r.name === n.bucket,
    )
  )
    throw new Error('Bucket name already exists; select another prefix');
  const queues = rows(cf(['queues', 'list'], c));
  for (const kind of ['queue', 'deadLetterQueue'])
    if (!owned(m, kind) && queues.some((r) => r.queue_name === n[kind]))
      throw new Error('Queue name already exists; select another prefix');
  const apps = listPages(['zero-trust', 'access', 'applications', 'list'], c);
  if (
    !owned(m, 'accessApplication') &&
    apps.some(
      (a) =>
        a.name === n.accessApplication ||
        a.domain === c.hostname ||
        a.domain?.startsWith(c.hostname + '/'),
    )
  )
    throw new Error(
      'An Access application already protects this hostname/name; use another hostname or configure Access manually',
    );
  const existingWorkers = listPages(['workers', 'list'], c);
  if (!owned(m, 'worker') && existingWorkers.some((w) => w.name === n.worker))
    throw new Error('Worker name already exists; select another prefix');
  const policies = rows(cf(['zero-trust', 'access', 'policies', 'list'], c));
  if (!owned(m, 'accessPolicy') && policies.some((p) => p.name === n.accessPolicy))
    throw new Error('Access policy name already exists; select another prefix');
  if (!owned(m, 'database')) {
    const d = cf(['d1', 'create'], c, { name: n.database });
    m.databaseId = d.uuid || d.id;
    if (!m.databaseId) throw new Error('D1 did not return its ID');
    record(m, c, 'database', m.databaseId, n.database);
  }
  if (!owned(m, 'bucket')) {
    const created = cf(['r2', 'buckets', 'create'], c, { name: n.bucket });
    record(m, c, 'bucket', n.bucket, n.bucket, {
      bucketIdentity: createBucketIdentity(c, m, n.bucket, created),
    });
  }
  if (owned(m, 'bucket')?.bucketIdentity) verifyBucketIdentity(c, m, owned(m, 'bucket'));
  for (const kind of ['deadLetterQueue', 'queue'])
    if (!owned(m, kind)) {
      const q = cf(['queues', 'create'], c, { queue_name: n[kind] });
      record(m, c, kind, q.queue_id || q.id, n[kind]);
    }
  const policy = {
    name: n.accessPolicy,
    decision: 'allow',
    include: c.access.allowedUsers.map((email) => ({ email: { email: email.toLowerCase() } })),
    require: [
      { login_method: { id: idp.id } },
      ...(idp.type === 'cloudflare'
        ? [{ cloudflare_account_member: { account_id: c.accountId } }]
        : []),
    ],
    session_duration: c.access.sessionDuration,
    ...(c.access.mfa
      ? {
          mfa_config: {
            mfa_disabled: false,
            allowed_authenticators: ['security_key', 'biometrics'],
            session_duration: c.access.sessionDuration,
          },
        }
      : org.mfa_config?.allowed_authenticators?.length
        ? { mfa_config: { mfa_disabled: true } }
        : {}),
  };
  if (!owned(m, 'accessPolicy')) {
    const p = cf(['zero-trust', 'access', 'policies', 'create'], c, policy);
    record(m, c, 'accessPolicy', p.id, n.accessPolicy);
  } else cf(['zero-trust', 'access', 'policies', 'update', owned(m, 'accessPolicy').id], c, policy);
  if (!owned(m, 'accessApplication')) {
    const app = cf(['zero-trust', 'access', 'applications', 'create'], c, {
      name: n.accessApplication,
      type: 'self_hosted',
      domain: c.hostname,
      allowed_idps: [idp.id],
      session_duration: c.access.sessionDuration,
      policies: [{ id: owned(m, 'accessPolicy').id }],
      ...(policy.mfa_config ? { mfa_config: policy.mfa_config } : {}),
    });
    record(m, c, 'accessApplication', app.id, n.accessApplication);
    c.access.audience = app.aud;
    m.audience = app.aud;
  } else {
    const app = cf(
      ['zero-trust', 'access', 'applications', 'get', owned(m, 'accessApplication').id],
      c,
    );
    if (app.name !== n.accessApplication || app.domain !== c.hostname)
      throw new Error('Access application identity changed; refusing update');
    const updated = cf(['zero-trust', 'access', 'applications', 'update', app.id], c, {
      ...app,
      allowed_idps: [idp.id],
      policies: [{ id: owned(m, 'accessPolicy').id }],
      session_duration: c.access.sessionDuration,
      ...(policy.mfa_config ? { mfa_config: policy.mfa_config } : {}),
    });
    cf(['zero-trust', 'access', 'applications', 'revoke-tokens', app.id, '--force'], c);
    c.access.audience = updated.aud || app.aud;
    m.audience = c.access.audience;
  }
  if (!c.access.audience)
    throw new Error('Access application did not return an audience; install remains locked');
  writeConfig(c);
  save(m);
  rawSql(c, m, 'CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY)');
  const applied = new Set(rows(rawSql(c, m, 'SELECT id FROM schema_migrations')).map((x) => x.id));
  for (const file of readdirSync('migrations')
    .filter((f) => /^\d+\.sql$/.test(f))
    .sort()) {
    const id = file.slice(0, -4);
    if (!applied.has(id)) {
      rawSql(c, m, readFileSync(`migrations/${file}`, 'utf8'));
      rawSql(c, m, 'INSERT INTO schema_migrations(id) VALUES(?)', [id]);
    }
  }
  for (const a of c.addresses)
    rawSql(
      c,
      m,
      'INSERT OR IGNORE INTO addresses(id,email,name,color,signature,created_at) VALUES(?,?,?,?,?,?)',
      [randomUUID(), a.email.toLowerCase(), a.name, a.color, a.signature, new Date().toISOString()],
    );
  for (const [file, args] of [
    [cli, ['workers', 'types']],
    [resolve('node_modules/typescript/bin/tsc'), ['--noEmit']],
    [cli, ['build']],
  ])
    execFileSync(process.execPath, [file, ...args], {
      stdio: 'inherit',
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: c.accountId },
    });
  let deployError;
  try {
    execFileSync(process.execPath, [cli, 'deploy'], {
      stdio: 'inherit',
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: c.accountId },
    });
  } catch (error) {
    deployError = error;
  }
  const worker = listPages(['workers', 'list'], c).find((w) => w.name === n.worker);
  if (!worker?.id)
    throw new Error(
      'Worker deployed but its exact ID was not returned; run cf workers list and retain the ID before cleanup',
    );
  if (!owned(m, 'worker')) record(m, c, 'worker', worker.id, n.worker);
  if (deployError)
    throw new Error(
      'Deployment did not finish; exact Worker ownership was retained. Correct the error and rerun install.',
    );
  m.status = 'deployed';
  m.updatedAt = new Date().toISOString();
  save(m);
  console.log(
    `${upgrade ? 'Updated' : 'Deployed'} https://${c.hostname}. Configure/verify Email Routing and Sending, then run connect-mail. Run doctor and verify login before directing real mail here.`,
  );
}
function connect(c, m) {
  validateLive(c);
  syncRuntimeRoutes(c, m);
  const n = names(c);
  for (const d of c.domains.filter((d) => d.receiving)) {
    const zone = cf(['zones', 'get', '--zone', d.zoneId], c);
    if (d.name !== zone.name && !d.name.endsWith('.' + zone.name))
      throw new Error('Mail domain does not belong to its configured zone');
    if (d.catchAll && d.name !== zone.name)
      throw new Error(
        'Catch-all routing is supported only on the zone apex; use explicit rules for subdomains',
      );
    const settings = cf(['email-routing', 'settings', 'get', '--zone', d.zoneId], c);
    if (!settings.enabled)
      throw new Error(
        `Onboard Email Routing for ${d.name} in Cloudflare first. This tool does not replace existing MX records.`,
      );
    if (d.catchAll) {
      const current = cf(['email-routing', 'rules', 'catch-all', 'get', '--zone', d.zoneId], c);
      const tracked = m.routes.find((r) => r.kind === 'catchAll' && r.zoneId === d.zoneId);
      if (current.enabled && !tracked)
        throw new Error(`Existing catch-all for ${d.name} must be reviewed; refusing takeover`);
      const body = {
        name: `${c.resourcePrefix}: intake`,
        enabled: true,
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [n.worker] }],
      };
      cf(['email-routing', 'rules', 'catch-all', 'update', '--zone', d.zoneId], c, body);
      if (!tracked)
        m.routes.push({
          kind: 'catchAll',
          zoneId: d.zoneId,
          id: current.id,
          previous: current,
          body,
        });
      save(m);
    } else {
      for (const a of rows(rawSql(c, m, 'SELECT email FROM addresses')).filter((a) =>
        a.email.endsWith('@' + d.name),
      )) {
        if (m.routes.some((r) => r.email === a.email)) continue;
        const existing = listPages(
          ['email-routing', 'rules', 'list-account', '--zone', d.zoneId],
          c,
        );
        if (existing.some((r) => r.matchers?.some((x) => x.value === a.email)))
          throw new Error(`Existing route for ${a.email}; refusing takeover`);
        const body = {
          name: `${c.resourcePrefix}: ${a.email}`,
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: a.email }],
          actions: [{ type: 'worker', value: [n.worker] }],
        };
        const r = cf(['email-routing', 'rules', 'create', '--zone', d.zoneId], c, body);
        m.routes.push({ kind: 'literal', zoneId: d.zoneId, email: a.email, id: r.id, body });
        save(m);
      }
    }
  }
  console.log(
    'Owned receiving routes configured. For delivery tracking, subscribe this installation’s jobs queue to Email Sending events for each sending domain in the Cloudflare dashboard. This cf beta does not expose the email event source in its typed subscription schema.',
  );
}
async function doctor(c, m) {
  validateManifest(m, c);
  syncRuntimeRoutes(c, m);
  for (const r of m.resources.filter((r) => r.owned)) {
    const cmd = {
      worker: ['workers', 'get', r.id],
      database: ['d1', 'get', r.id],
      bucket: ['r2', 'buckets', 'get', r.name],
      eventSubscription: ['queues', 'subscriptions', 'get', r.id],
      queue: ['queues', 'get', r.id],
      deadLetterQueue: ['queues', 'get', r.id],
      accessApplication: ['zero-trust', 'access', 'applications', 'get', r.id],
      accessPolicy: ['zero-trust', 'access', 'policies', 'get', r.id],
    }[r.kind];
    if (cmd) {
      const current = cf(cmd, c);
      if ((current.name || current.queue_name) !== r.name)
        throw new Error(`Owned ${r.kind} identity differs from its manifest`);
      console.log(`OK ${r.kind}: ${r.name}`);
    }
  }
  const bucket = owned(m, 'bucket');
  if (bucket?.bucketIdentity) verifyBucketIdentity(c, m, bucket);
  else if (bucket)
    console.log(
      'Legacy bucket: destructive mail cleanup is blocked until ownership is explicitly reconciled. --keep-mail remains available.',
    );
  const app = cf(
    ['zero-trust', 'access', 'applications', 'get', owned(m, 'accessApplication').id],
    c,
  );
  if (app.aud !== c.access.audience || app.domain !== c.hostname)
    throw new Error('Access audience/hostname differs from runtime configuration');
  const p = cf(['zero-trust', 'access', 'policies', 'get', owned(m, 'accessPolicy').id], c);
  if (
    p.decision !== 'allow' ||
    p.include.some((x) => !x.email) ||
    JSON.stringify(p.include.map((x) => x.email.email.toLowerCase()).sort()) !==
      JSON.stringify(c.access.allowedUsers.map((x) => x.toLowerCase()).sort()) ||
    !p.require?.some((x) => x.login_method?.id === c.access.identityProviderId) ||
    app.policies?.length !== 1 ||
    (typeof app.policies[0] === 'string' ? app.policies[0] : app.policies[0].id) !==
      owned(m, 'accessPolicy').id
  )
    throw new Error('Access policy is broader than the configured user allowlist');
  const probe = await fetch(`https://${c.hostname}/api/bootstrap`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  const location = probe.headers.get('Location'),
    redirect = location ? new URL(location, `https://${c.hostname}`) : null;
  if (
    ![401, 403].includes(probe.status) &&
    !(
      probe.status >= 300 &&
      probe.status < 400 &&
      redirect &&
      [c.hostname, c.access.teamDomain].includes(redirect.hostname) &&
      redirect.pathname.startsWith('/cdn-cgi/access/')
    )
  )
    throw new Error(
      'Unsigned API did not return an authentication denial or Access login redirect',
    );
  console.log(
    `OK unsigned API denied (${probe.status}). Also verify a real signed-in browser session, optional MFA settings, all enabled URLs, and test email delivery.`,
  );
}
function removeRoutes(c, m) {
  for (const r of [...m.routes]) {
    if (r.kind === 'literal') {
      const current = cf(['email-routing', 'rules', 'get', r.id, '--zone', r.zoneId], c);
      if (
        JSON.stringify(current.actions) !== JSON.stringify(r.body.actions) ||
        current.name !== r.body.name ||
        !current.matchers?.some((x) => x.value === r.email)
      )
        throw new Error('Literal route changed ownership; refusing deletion');
      cf(['email-routing', 'rules', 'delete', r.id, '--zone', r.zoneId, '--force'], c);
    } else {
      const current = cf(['email-routing', 'rules', 'catch-all', 'get', '--zone', r.zoneId], c);
      if (JSON.stringify(current.actions) !== JSON.stringify(r.body.actions))
        throw new Error('Catch-all has changed ownership; refusing to overwrite it');
      cf(['email-routing', 'rules', 'catch-all', 'update', '--zone', r.zoneId], c, {
        actions: r.previous.actions || [],
        matchers: r.previous.matchers || [{ type: 'all' }],
        enabled: !!r.previous.enabled,
        name: r.previous.name || '',
      });
    }
    m.removedRouteIds = [...(m.removedRouteIds || []), r.id];
    m.routes = m.routes.filter((x) => x !== r);
    save(m);
  }
}
function uninstall(c, m) {
  validateManifest(m, c);
  const deleteMail = flags.has('--delete-mail');
  const planned = m.resources.filter(
    (r) => r.owned && (deleteMail || !['database', 'bucket'].includes(r.kind)),
  );
  console.log(
    JSON.stringify(
      {
        accountId: m.accountId,
        installation: m.installId,
        remove: planned,
        retain: m.resources.filter((r) => !planned.includes(r)),
        routes: m.routes,
      },
      null,
      2,
    ),
  );
  if (!flags.has('--apply')) return;
  if (deleteMail && !flags.has(`--confirm-prefix=${m.prefix}`))
    throw new Error('Permanent deletion requires --confirm-prefix matching this installation');
  const worker = owned(m, 'worker');
  if (worker) {
    const current = cf(['workers', 'get', worker.id], c);
    if (current.name !== worker.name)
      throw new Error('Worker ID/name no longer matches this installation');
  }
  syncRuntimeRoutes(c, m);
  for (const r of planned) {
    if (r.kind === 'worker') continue;
    const cmd = {
      database: ['d1', 'get', r.id],
      bucket: ['r2', 'buckets', 'get', r.name],
      queue: ['queues', 'get', r.id],
      deadLetterQueue: ['queues', 'get', r.id],
      accessApplication: ['zero-trust', 'access', 'applications', 'get', r.id],
      accessPolicy: ['zero-trust', 'access', 'policies', 'get', r.id],
      eventSubscription: ['queues', 'subscriptions', 'get', r.id],
    }[r.kind];
    if (!cmd) throw new Error('Unknown owned resource kind');
    const current = cf(cmd, c);
    if ((current.name || current.queue_name) !== r.name)
      throw new Error(`Owned ${r.kind} name changed; refusing deletion`);
  }
  if (deleteMail && owned(m, 'bucket')) {
    const auditId = [...flags].find((f) => f.startsWith('--bucket-audit-id='))?.slice(18);
    if (!owned(m, 'bucket').bucketIdentity && auditId)
      reconcileLegacyBucket(c, m, { auditId, apply: true, confirmPrefix: m.prefix, persist: save });
    verifyBucketIdentity(c, m, owned(m, 'bucket'));
  }
  const detach = [];
  if (worker)
    for (const q of m.resources.filter(
      (r) => r.owned && ['queue', 'deadLetterQueue'].includes(r.kind),
    )) {
      for (const consumer of rows(cf(['queues', 'consumers', 'list', '--queue-id', q.id], c))) {
        if (
          consumer.type !== 'worker' ||
          consumer.script !== worker.name ||
          consumer.queue_id !== q.id ||
          !consumer.consumer_id
        )
          throw new Error('Owned queue has an unrecognized or foreign consumer; refusing teardown');
        detach.push({ queueId: q.id, id: consumer.consumer_id });
      }
    }
  removeRoutes(c, m);
  for (const consumer of detach) {
    const current = rows(
      cf(['queues', 'consumers', 'list', '--queue-id', consumer.queueId], c),
    ).find((x) => x.consumer_id === consumer.id);
    if (!current) continue;
    if (
      current.type !== 'worker' ||
      current.script !== worker.name ||
      current.queue_id !== consumer.queueId
    )
      throw new Error('Queue consumer changed ownership during teardown; refusing detachment');
    cf(
      ['queues', 'consumers', 'delete', consumer.id, '--queue-id', consumer.queueId, '--force'],
      c,
    );
    m.detachedConsumers = [
      ...(m.detachedConsumers || []),
      { ...consumer, detachedAt: new Date().toISOString() },
    ];
    save(m);
  }
  // Remove the serving Worker first. Access stays intact while any application endpoint exists.
  const order = [
    'worker',
    'eventSubscription',
    'queue',
    'deadLetterQueue',
    ...(deleteMail ? ['bucket', 'database'] : []),
    'accessApplication',
    'accessPolicy',
  ];
  for (const kind of order) {
    for (const r of m.resources.filter((r) => r.owned && r.kind === kind && planned.includes(r))) {
      if (kind === 'eventSubscription') {
        const sub = cf(['queues', 'subscriptions', 'get', r.id], c);
        if (
          sub.destination?.queue_id !== m.resources.find((x) => x.kind === 'queue')?.id ||
          sub.name !== r.name
        )
          throw new Error('Event subscription ownership changed');
        cf(['queues', 'subscriptions', 'delete', r.id, '--force'], c);
      } else if (kind === 'worker') cf(['workers', 'delete', r.id, '--force'], c);
      else if (kind === 'queue' || kind === 'deadLetterQueue') {
        if (rows(cf(['queues', 'consumers', 'list', '--queue-id', r.id], c)).length)
          throw new Error('Queue has consumers after detachment; refusing queue deletion');
        cf(['queues', 'delete', r.id, '--force'], c);
      } else if (kind === 'database') cf(['d1', 'delete', r.id, '--force'], c);
      else if (kind === 'bucket') {
        let page;
        verifyBucketIdentity(c, m, r);
        do {
          page = cf(['r2', 'objects', 'list', '--bucket-name', r.name, '--per-page', '1000'], c);
          const keys = rows(page)
            .map((x) => x.key)
            .filter((key) => key !== BUCKET_MARKER);
          if (keys.length) verifyBucketIdentity(c, m, r);
          if (keys.length)
            cf(['r2', 'objects', 'bulk-delete', '--bucket-name', r.name, '--force'], c, keys);
          else break;
        } while (rows(page).length);
        verifyBucketIdentity(c, m, r);
        cf(['r2', 'objects', 'delete', BUCKET_MARKER, '--bucket-name', r.name, '--force'], c);
        cf(['r2', 'buckets', 'delete', r.name, '--force'], c);
      } else if (kind === 'accessApplication')
        cf(['zero-trust', 'access', 'applications', 'delete', r.id, '--force'], c);
      else if (kind === 'accessPolicy') {
        const apps = listPages(['zero-trust', 'access', 'applications', 'list'], c);
        const references = apps.filter((a) =>
          a.policies?.some((p) => (typeof p === 'string' ? p : p.id) === r.id),
        );
        if (references.length) {
          r.owned = false;
          r.retainedShared = true;
          r.retentionReason = 'Referenced by another Access application';
          r.sharedWith = references.map((a) => a.id);
          save(m);
          console.log(`Retained shared Access policy: ${r.name}`);
          continue;
        }
        cf(['zero-trust', 'access', 'policies', 'delete', r.id, '--force'], c);
      }
      r.owned = false;
      r.removedAt = new Date().toISOString();
      save(m);
    }
  }
  m.status = deleteMail ? 'removed' : 'mail-retained';
  save(m);
  console.log(
    `Removal complete. ${deleteMail ? 'Owned mail storage deleted.' : 'D1/R2 mail retained; installation manifest preserved.'}`,
  );
}
function syncRuntimeRoutes(c, m) {
  if (!owned(m, 'worker') || !owned(m, 'database')) return;
  const stored = rows(rawSql(c, m, "SELECT value FROM settings WHERE key LIKE 'route:%'"));
  for (const row of stored) {
    const r = JSON.parse(row.value);
    if (!c.domains.some((d) => d.zoneId === r.zoneId))
      throw new Error('Stored route belongs to an unconfigured zone');
    if (!r.id || !r.body || !r.email) throw new Error('Incomplete runtime route ownership record');
    if (m.removedRouteIds?.includes(r.id)) continue;
    if (!m.routes.some((x) => x.id === r.id)) m.routes.push({ ...r, kind: 'literal' });
  }
  save(m);
}
function registerEvents(c, m) {
  const id = [...flags].find((f) => f.startsWith('--subscription='))?.split('=')[1];
  if (!flags.has('--apply') || !id || !/^[a-f0-9-]{32,36}$/.test(id))
    throw new Error(
      'Use register-events --apply --subscription=ID to authorize ownership of your manually created subscription',
    );
  const sub = cf(['queues', 'subscriptions', 'get', id], c);
  if (
    sub.destination?.queue_id !== owned(m, 'queue')?.id ||
    sub.source?.type !== 'email.sending' ||
    !c.domains.some((d) => d.sending && d.name === sub.source.domain)
  )
    throw new Error('Subscription source/destination differs from this installation');
  if (
    !owned(m, 'eventSubscription') ||
    !m.resources.some((r) => r.kind === 'eventSubscription' && r.id === id)
  )
    record(m, c, 'eventSubscription', id, sub.name);
  console.log('Recorded exact subscription ownership; uninstall can remove it safely.');
}
try {
  if (command === 'help') {
    console.log(help);
  } else if (command === 'init') {
    if (existsSync(path)) throw new Error('Configuration already exists');
    writeFileSync(path, readFileSync('mailbox.example.json'), { mode: 0o600 });
    console.log(
      'Created mailbox.config.json. Fill in account, hostname, permitted users, domains and initial addresses. MFA is optional and disabled by default.',
    );
  } else {
    const c = load(),
      n = names(c);
    if (command === 'plan') {
      console.log(
        JSON.stringify(
          {
            resources: n,
            hostname: c.hostname || '(configure later)',
            mfa: c.access.mfa,
            allowedUsers: c.access.allowedUsers,
            mailAddresses: c.addresses.map((a) => a.email),
          },
          null,
          2,
        ),
      );
    } else {
      if (command === 'install' || command === 'upgrade') {
        if (!flags.has('--apply')) throw new Error('Use plan to review, then install --apply');
        const m = existsSync(state)
          ? validateManifest(JSON.parse(readFileSync(state, 'utf8')), c)
          : {
              version: 1,
              installId: randomUUID(),
              accountId: c.accountId,
              prefix: c.resourcePrefix,
              resources: [],
              routes: [],
              status: 'installing',
            };
        save(m);
        await install(c, m, command === 'upgrade');
      } else {
        if (!existsSync(state))
          throw new Error('Installation manifest is missing; refusing account actions');
        const m = validateManifest(JSON.parse(readFileSync(state, 'utf8')), c);
        if (command === 'reconcile-bucket') {
          const auditId = [...flags].find((f) => f.startsWith('--audit-id='))?.slice(11);
          const confirmPrefix = [...flags]
            .find((f) => f.startsWith('--confirm-prefix='))
            ?.slice(17);
          console.log(
            JSON.stringify(
              reconcileLegacyBucket(c, m, {
                auditId,
                apply: flags.has('--apply') && !flags.has('--dry-run'),
                confirmPrefix,
                persist: save,
              }),
              null,
              2,
            ),
          );
        } else if (command === 'doctor') await doctor(c, m);
        else if (command === 'connect-mail') {
          if (!flags.has('--apply')) throw new Error('Use --apply to connect mail routes');
          connect(c, m);
        } else if (command === 'uninstall') uninstall(c, m);
        else if (command === 'export') exportMail(c, m);
        else if (command === 'restore') {
          const file = [...flags].find((f) => f.startsWith('--backup='))?.slice(9);
          if (!file) throw new Error('Use restore --backup=PATH/backup.json [--apply]');
          restoreMail(c, m, file, flags.has('--apply'));
        } else if (command === 'register-events') registerEvents(c, m);
        else throw new Error(help);
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Installation command failed');
  process.exitCode = 1;
}
