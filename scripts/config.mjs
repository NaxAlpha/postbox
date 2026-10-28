import { z } from 'zod';
const host = (s) =>
  s.length <= 253 &&
  s.split('.').length >= 2 &&
  s.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
const name = z.string().regex(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/);
export const configSchema = z
  .object({
    resourcePrefix: name.max(30),
    accountId: z.string().default(''),
    hostname: z.string().default(''),
    access: z.object({
      teamDomain: z.string().default(''),
      audience: z.string().default(''),
      allowedUsers: z.array(z.email()).default([]),
      identityProviderId: z.string().default(''),
      mfa: z.boolean().default(false),
      sessionDuration: z
        .string()
        .regex(/^\d+[mh]$/)
        .default('4h'),
    }),
    domains: z
      .array(
        z.object({
          name: z.string().refine(host, 'Use a lowercase DNS domain name'),
          zoneId: z.string().regex(/^[a-f0-9]{32}$/),
          sending: z.boolean().default(false),
          receiving: z.boolean().default(true),
          catchAll: z.boolean().default(true),
        }),
      )
      .default([]),
    addresses: z
      .array(
        z.object({
          email: z.email(),
          name: z.string().min(1).max(96),
          color: z
            .string()
            .regex(/^#[a-fA-F0-9]{6}$/)
            .default('#8272d5'),
          signature: z.string().max(5000).default(''),
        }),
      )
      .default([]),
    resources: z.object({
      worker: z.string().default(''),
      database: z.string().default(''),
      bucket: z.string().default(''),
      queue: z.string().default(''),
      deadLetterQueue: z.string().default(''),
      accessApplication: z.string().default(''),
      accessPolicy: z.string().default(''),
    }),
    limits: z.object({
      sendsPerHour: z.number().int().min(1).max(1000).default(100),
      trashDays: z.number().int().min(1).max(3650).default(30),
      spamDays: z.number().int().min(1).max(3650).default(30),
    }),
    providerRoutingTokenEnabled: z.boolean().default(false),
  })
  .strict();
export function names(c) {
  const p = c.resourcePrefix;
  const n = {
    worker: c.resources.worker || `${p}-app`,
    database: c.resources.database || `${p}-db`,
    bucket: c.resources.bucket || `${p}-mail`,
    queue: c.resources.queue || `${p}-jobs`,
    deadLetterQueue: c.resources.deadLetterQueue || `${p}-dlq`,
    accessApplication: c.resources.accessApplication || `${p}-access`,
    accessPolicy: c.resources.accessPolicy || `${p}-users`,
  };
  for (const [kind, v] of Object.entries(n)) {
    name.parse(v);
    if (!v.startsWith(p + '-'))
      throw new Error('Resource overrides must begin with resourcePrefix followed by a hyphen');
  }
  if (n.queue === n.deadLetterQueue)
    throw new Error('Main and dead-letter queues must have different names');
  return n;
}
export function validateLive(c) {
  if (!/^[a-f0-9]{32}$/.test(c.accountId))
    throw new Error('Set accountId to your Cloudflare account ID');
  if (!c.hostname || !host(c.hostname))
    throw new Error('Set a canonical mailbox hostname, such as mail.example.com');
  if (!c.access.allowedUsers.length)
    throw new Error('Set access.allowedUsers to exact permitted login emails');
  const emails = new Set();
  for (const a of c.addresses) {
    const email = a.email.toLowerCase();
    if (emails.has(email)) throw new Error('Duplicate initial mail address');
    emails.add(email);
    if (!c.domains.some((d) => d.name === email.split('@')[1] && d.receiving))
      throw new Error('Each initial mail address needs a configured receiving domain');
  }
  return names(c);
}
export function validateManifest(m, c) {
  if (m.accountId !== c.accountId || m.prefix !== c.resourcePrefix)
    throw new Error('Installation manifest does not match this account/prefix');
  if (m.version !== 1 || !m.installId || !Array.isArray(m.resources) || !Array.isArray(m.routes))
    throw new Error('Invalid installation manifest');
  const n = names(c);
  for (const r of m.resources) {
    if (!r.owned) continue;
    if (r.accountId !== c.accountId || !r.id || !r.name || r.installId !== m.installId)
      throw new Error('Invalid resource ownership in manifest');
    if (!(r.kind in n) && r.kind !== 'eventSubscription')
      throw new Error('Unknown owned resource kind');
    if (r.kind in n && r.name !== n[r.kind])
      throw new Error('Resource names changed. Restore the original configuration before cleanup');
  }
  if (m.resources.some((r) => r.kind === 'database' && r.owned && r.id !== m.databaseId))
    throw new Error('Database identity differs from ownership manifest');
  return m;
}
