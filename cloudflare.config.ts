import { bindings, defineConfig, triggers } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { configSchema, names as resourceNames, validateManifest } from './scripts/config.mjs';
import type { MailJob } from './src/shared/models';
const configPath = resolve('mailbox.config.json');
const c = configSchema.parse(
  JSON.parse(readFileSync(existsSync(configPath) ? configPath : 'mailbox.example.json', 'utf8')),
);
const manifest = existsSync('.postbox/install.json')
  ? validateManifest(JSON.parse(readFileSync('.postbox/install.json', 'utf8')), c)
  : {};
const prefix: string = c.resourcePrefix || 'postbox-prod';
const names = resourceNames(c);
export default defineConfig(({ mode }) => ({
  ...(c.accountId ? { accountId: c.accountId } : {}),
  worker: {
    name: mode === 'development' ? 'postbox-local' : names.worker,
    entrypoint,
    compatibilityDate: mode === 'development' ? '2026-10-13' : '2026-10-14',
    compatibilityFlags: ['nodejs_compat'],
    workersDev: false,
    previewUrls: false,
    ...(c.hostname ? { domains: [c.hostname] } : {}),
    assets: { runWorkerFirst: true, notFoundHandling: 'single-page-application' },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: false },
    },
    env: {
      ASSETS: bindings.assets(),
      DB: bindings.d1({
        name: names.database,
        ...(manifest.databaseId ? { id: manifest.databaseId } : {}),
      }),
      MAIL: bindings.r2({ name: names.bucket }),
      JOBS: bindings.queue<MailJob>({ name: names.queue }),
      EMAIL: bindings.sendEmail(),
      DEV_MODE: bindings.text(mode === 'development' ? 'local' : 'off'),
      APP_ORIGIN: bindings.text(c.hostname ? `https://${c.hostname}` : ''),
      ACCESS_ISSUER: bindings.text(
        c.access.teamDomain
          ? `https://${c.access.teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
          : '',
      ),
      ACCESS_AUD: bindings.text(c.access.audience || ''),
      ALLOWED_USERS: bindings.text(JSON.stringify(c.access.allowedUsers || [])),
      DOMAINS: bindings.text(JSON.stringify(c.domains || [])),
      SEND_LIMIT: bindings.text(String(c.limits?.sendsPerHour || 100)),
      RESOURCE_PREFIX: bindings.text(prefix),
      WORKER_NAME: bindings.text(names.worker),
      TRASH_DAYS: bindings.text(String(c.limits?.trashDays || 30)),
      SPAM_DAYS: bindings.text(String(c.limits?.spamDays || 30)),
      ROUTING_TOKEN:
        c.providerRoutingTokenEnabled && mode !== 'development'
          ? bindings.secret()
          : bindings.text(''),
    },
    triggers: [
      triggers.queue({
        name: names.queue,
        maxBatchSize: 1,
        maxRetries: 3,
        deadLetterQueue: names.deadLetterQueue,
      }),
      triggers.scheduled({ schedule: '*/5 * * * *' }),
    ],
  },
}));
