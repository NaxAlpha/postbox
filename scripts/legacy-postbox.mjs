#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { configSchema, validateLive, validateManifest } from './config.mjs';
import {
  inspectSetup,
  printSetup,
  applyDomains,
  ensureIdentity,
  savePrivate,
  setupState,
  recordHostDNS,
} from './setup.mjs';
import { destroyInstallation } from './destroy.mjs';
import { wizard, terminalPrompt } from './wizard.mjs';
const args = process.argv.slice(2),
  command = (args.shift() || 'help').replace(/^destory$/, 'destroy');
const { values } = parseArgs({
  args,
  strict: true,
  options: {
    project: { type: 'string' },
    config: { type: 'string' },
    yes: { type: 'boolean' },
    'no-dns': { type: 'boolean' },
    reconfigure: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean' },
    apply: { type: 'boolean' },
    backup: { type: 'string' },
    'delete-mail': { type: 'boolean' },
    'keep-mail': { type: 'boolean' },
    'confirm-prefix': { type: 'string' },
    subscription: { type: 'string' },
    'audit-id': { type: 'string' },
    'bucket-audit-id': { type: 'string' },
  },
});
const flag = (name) => values[name.slice(2)] === true,
  option = (name) => values[name.slice(2)];
const project = option('--project');
if (project) process.chdir(resolve(project));
function run(file, values, inherit = true) {
  const result = spawnSync(process.execPath, [file, ...values], {
    stdio: inherit && !process.env.POSTBOX_JSON ? 'inherit' : 'pipe',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (process.env.POSTBOX_JSON && result.stdout?.length) console.log(result.stdout.toString());
  if (result.status !== 0)
    throw new Error(
      `Command failed (${result.status ?? 'interrupted'}): ${values[0] || file}${result.stderr?.length ? ': ' + result.stderr.toString().trim() : ''}`,
    );
}
function installer(action, values = []) {
  run(resolve('scripts/mailbox.mjs'), [action, ...values]);
}
function load() {
  if (!existsSync('mailbox.config.json')) throw new Error('Run postbox init first');
  return configSchema.parse(JSON.parse(readFileSync('mailbox.config.json', 'utf8')));
}
const help = `Postbox — your self-hosted Cloudflare mailbox

  postbox login                    Sign in with cf
  postbox init                     Select account, domains, hostname, login users and addresses
  postbox init --config=FILE --yes  Import explicit settings and prepare domain DNS
  postbox init --no-dns             Save configuration without changing Cloudflare
  postbox init --reconfigure        Edit existing settings; installed resource identities stay pinned
  postbox start                    Start loopback local preview (simulated sends)
  postbox deploy                   Review DNS, provision Access/storage, deploy and connect mail
  postbox deploy --yes              Non-interactive deploy with conflict checks
  postbox deploy --dry-run          Inspect domain/DNS/resource plan without changes
  postbox domains                   Inspect domain/DNS status and conflicts
  postbox domains --apply --yes     Prepare selected mail domains and DNS using cf
  postbox plan                     Print local configuration/resource plan
  postbox doctor                   Check deployed resources and Access
  postbox export                   Back up private mail
  postbox restore --backup=PATH [--apply]
  postbox destroy                  Preview removal of ALL owned resources and mail
  postbox destroy --apply --confirm-prefix=PREFIX [--keep-mail]

Run in your Postbox source checkout after npm ci. npm link exposes the postbox command;
npm run postbox -- COMMAND works without a global link. --project=PATH selects a checkout.
Cloudflare changes always use the project's pinned cf CLI. Existing conflicting DNS is never replaced.
`;
let prompt;
async function confirm(message) {
  if (flag('--yes')) return true;
  if (process.env.POSTBOX_NON_INTERACTIVE)
    throw new Error('Confirmation required: supply --yes for non-interactive changes');
  prompt ||= terminalPrompt();
  return (
    (await prompt.ask(message + ' yes/no', 'no', (v) => {
      if (!['yes', 'no'].includes(v)) throw new Error('Enter yes or no');
    })) === 'yes'
  );
}
try {
  if (command === 'help' || flag('--help') || command === '--help') {
    console.log(help);
  } else {
    if (!existsSync('cloudflare.config.ts') || !existsSync('scripts/mailbox.mjs'))
      throw new Error('Run inside a Postbox source checkout, or specify --project=PATH');
    if (command === 'login') {
      run(resolve('node_modules/cf/bin/cf'), ['auth', 'login']);
    } else if (command === 'start') {
      run(resolve('node_modules/cf/bin/cf'), ['dev']);
    } else if (command === 'init') {
      const current = existsSync('mailbox.config.json') ? load() : undefined;
      if (current && !flag('--reconfigure'))
        throw new Error(
          'Configuration already exists. Use postbox init --reconfigure; it is never overwritten implicitly.',
        );
      let c;
      const input = option('--config');
      if (input) c = configSchema.parse(JSON.parse(readFileSync(resolve(input), 'utf8')));
      else {
        prompt = terminalPrompt();
        c = await wizard({ current, ask: prompt.ask });
      }
      validateLive(c);
      if (existsSync('.postbox/setup.json')) setupState(c);
      if (existsSync('.postbox/install.json')) {
        const manifest = JSON.parse(readFileSync('.postbox/install.json', 'utf8'));
        validateManifest(manifest, c);
        if (current && c.hostname !== current.hostname)
          throw new Error(
            'An installed mailbox hostname is pinned. Use a separate installation to change it.',
          );
      }
      console.log(
        JSON.stringify(
          {
            accountId: c.accountId,
            hostname: c.hostname,
            users: c.access.allowedUsers,
            addresses: c.addresses.map((a) => a.email),
            prefix: c.resourcePrefix,
          },
          null,
          2,
        ),
      );
      if (flag('--no-dns')) {
        if (!flag('--dry-run')) {
          savePrivate('mailbox.config.json', c);
          console.log('Saved private configuration. Run postbox deploy to prepare DNS and deploy.');
        }
      } else {
        const plan = inspectSetup(c);
        printSetup(plan);
        if (plan.conflicts.length)
          throw new Error(
            'Resolve the listed DNS/routing conflicts or choose another domain/subdomain. No settings were saved.',
          );
        if (
          !flag('--dry-run') &&
          (await confirm('Save this configuration and prepare the listed mail DNS records?'))
        ) {
          savePrivate('mailbox.config.json', c);
          applyDomains(c, plan);
          console.log(
            'Domain setup saved. Run postbox deploy to create the protected mailbox and connect its addresses.',
          );
        }
      }
    } else if (command === 'domains' || command === 'deploy') {
      const c = load(),
        plan = inspectSetup(c);
      printSetup(plan);
      if (plan.conflicts.length)
        throw new Error(
          'Cloudflare setup blocked by the conflicts listed above; existing services were preserved.',
        );
      if (flag('--dry-run') || (command === 'domains' && !flag('--apply'))) {
      } else if (
        await confirm(
          command === 'deploy'
            ? 'Apply this plan, deploy the protected Worker, and connect the configured addresses?'
            : 'Apply domain/DNS setup?',
        )
      ) {
        applyDomains(c, plan);
        if (command === 'deploy') {
          ensureIdentity(c);
          installer(existsSync('.postbox/install.json') ? 'upgrade' : 'install', ['--apply']);
          recordHostDNS(c, plan);
          installer('connect-mail', ['--apply']);
          installer('doctor');
          console.log(`Postbox deployed: https://${c.hostname}`);
        }
      }
    } else if (command === 'destroy') {
      destroyInstallation(load(), {
        apply: flag('--apply') && !flag('--dry-run'),
        keepMail: flag('--keep-mail'),
        confirmPrefix: option('--confirm-prefix'),
        bucketAuditId: option('--bucket-audit-id'),
        installer,
      });
    } else {
      const passthrough = {
        plan: 'plan',
        doctor: 'doctor',
        export: 'export',
        restore: 'restore',
        destroy: 'uninstall',
        'register-events': 'register-events',
        'reconcile-bucket': 'reconcile-bucket',
      }[command];
      if (!passthrough) throw new Error(`Unknown command: ${command}. Run postbox help.`);
      const forwarded = args.filter(
        (a, i) => !a.startsWith('--project=') && a !== '--project' && args[i - 1] !== '--project',
      );
      const normalized = forwarded.flatMap((value, i) => {
        if (i > 0 && ['--audit-id', '--confirm-prefix'].includes(forwarded[i - 1])) return [];
        return ['--audit-id', '--confirm-prefix'].includes(value)
          ? [`${value}=${forwarded[i + 1]}`]
          : [value];
      });
      installer(passthrough, normalized);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Postbox command failed');
  process.exitCode = 1;
} finally {
  prompt?.close();
}
