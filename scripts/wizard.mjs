import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { configSchema, validateLive } from './config.mjs';
import { discoverAccounts, discoverZones } from './setup.mjs';
export function selectedNumbers(value, length, multiple = false) {
  const tokens = value.split(',').map((x) => x.trim());
  if (!tokens.length || tokens.some((x) => !/^\d+$/.test(x)))
    throw new Error('Enter listed numbers separated by commas');
  const numbers = [...new Set(tokens.map(Number))];
  if (numbers.some((n) => n < 1 || n > length) || (!multiple && numbers.length !== 1))
    throw new Error('Choose valid listed numbers');
  return numbers.map((n) => n - 1);
}
export function terminalPrompt() {
  if (!stdin.isTTY)
    throw new Error(
      'Interactive setup needs a terminal. Use postbox init --config=FILE --yes, or --no-dns to save only.',
    );
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (label, fallback = '', check = () => {}) => {
    while (true) {
      const value =
        (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
      try {
        check(value);
        return value;
      } catch (error) {
        stdout.write(`  ${error.message}\n`);
      }
    }
  };
  return { ask, close: () => rl.close() };
}
export async function wizard({
  current,
  ask,
  log = console.log,
  accounts = discoverAccounts,
  zones = discoverZones,
} = {}) {
  const c = current
    ? structuredClone(current)
    : configSchema.parse(JSON.parse(readFileSync('mailbox.example.json', 'utf8')));
  log(
    'Postbox setup — cf discovers accounts and domains; no cloud changes are made during selection.',
  );
  const choices = accounts();
  if (!choices.length)
    throw new Error('No Cloudflare accounts are accessible. Run postbox login first.');
  choices.forEach((a, i) => log(`${i + 1}. ${a.name} (${a.id})`));
  const accountChoice = await ask(
    'Cloudflare account',
    String(
      Math.max(
        0,
        choices.findIndex((a) => a.id === c.accountId),
      ) + 1,
    ),
    (v) => selectedNumbers(v, choices.length),
  );
  const accountId = choices[selectedNumbers(accountChoice, choices.length)[0]].id;
  if (c.accountId && c.accountId !== accountId) {
    c.access.teamDomain = '';
    c.access.identityProviderId = '';
    c.access.audience = '';
  }
  c.accountId = accountId;
  const available = zones(c.accountId);
  if (!available.length) throw new Error('This account has no active Cloudflare DNS zones');
  log('\nAvailable domains:');
  available.forEach((z, i) => log(`${i + 1}. ${z.name}`));
  const defaults =
    available
      .flatMap((z, i) => (c.domains.some((d) => d.zoneId === z.id) ? [i + 1] : []))
      .join(',') || '1';
  const selected = await ask('Mail domain(s), comma-separated numbers', defaults, (v) =>
    selectedNumbers(v, available.length, true),
  );
  const domains = [];
  for (const index of selectedNumbers(selected, available.length, true)) {
    const zone = available[index],
      previous = c.domains.find((d) => d.zoneId === zone.id);
    const mailNames = await ask(
      `Mail domains under ${zone.name} (apex or subdomains, comma-separated)`,
      c.domains
        .filter((d) => d.zoneId === zone.id)
        .map((d) => d.name)
        .join(',') || zone.name,
      (v) => {
        for (const name of v.split(',').map((x) => x.trim())) {
          if (name !== zone.name && !name.endsWith('.' + zone.name))
            throw new Error('Use the selected domain or one of its subdomains');
          configSchema.shape.domains.unwrap().element.shape.name.parse(name);
        }
      },
    );
    for (const name of [...new Set(mailNames.split(',').map((x) => x.trim()))]) {
      const old = c.domains.find((d) => d.name === name) || previous;
      const mode = await ask(
        `${name}: 1 send + receive, 2 receive only, 3 send only`,
        old && !old.sending ? '2' : old && !old.receiving ? '3' : '1',
        (v) => {
          if (!['1', '2', '3'].includes(v)) throw new Error('Choose 1, 2, or 3');
        },
      );
      const catchAll =
        mode !== '3' && name === zone.name
          ? (await ask(
              `${name}: allow browser-created aliases with catch-all? yes/no`,
              old?.catchAll ? 'yes' : 'no',
              (v) => {
                if (!['yes', 'no'].includes(v)) throw new Error('Enter yes or no');
              },
            )) === 'yes'
          : false;
      domains.push({
        name,
        zoneId: zone.id,
        sending: mode !== '2',
        receiving: mode !== '3',
        catchAll,
      });
    }
  }
  c.domains = domains;
  log('\nChoose the browser hostname (independent of your email addresses):');
  available.forEach((z, i) => log(`${i + 1}. ${z.name}`));
  const hostDefault = available.findIndex(
    (z) => c.hostname === z.name || c.hostname.endsWith('.' + z.name),
  );
  const hostIndex = selectedNumbers(
    await ask(
      'Browser hostname base domain',
      String(
        hostDefault >= 0
          ? hostDefault + 1
          : available.findIndex((z) => z.id === domains[0].zoneId) + 1,
      ),
      (v) => selectedNumbers(v, available.length),
    ),
    available.length,
  )[0];
  const hostZone = available[hostIndex];
  const prefix = await ask(
    'Mailbox subdomain (e.g. mail; @ for apex)',
    c.hostname.endsWith('.' + hostZone.name)
      ? c.hostname.slice(0, -hostZone.name.length - 1)
      : 'mail',
    (v) => {
      configSchema.shape.domains
        .unwrap()
        .element.shape.name.parse(v === '@' ? hostZone.name : `${v}.${hostZone.name}`);
    },
  );
  c.hostname = prefix === '@' ? hostZone.name : `${prefix}.${hostZone.name}`;
  c.resourcePrefix = await ask('Resource prefix', c.resourcePrefix, (v) =>
    configSchema.shape.resourcePrefix.parse(v),
  );
  const users = await ask(
    'Exact email(s) allowed to log in, comma-separated',
    c.access.allowedUsers.join(','),
    (v) => {
      const a = v.split(',').map((x) => x.trim().toLowerCase());
      if (!v) throw new Error('At least one login email is required');
      configSchema.shape.access.shape.allowedUsers.parse(a);
    },
  );
  c.access.allowedUsers = [...new Set(users.split(',').map((x) => x.trim().toLowerCase()))];
  log(
    'Login uses Cloudflare Access. MFA stays optional; existing organization policies are preserved.',
  );
  const mfa = await ask(
    'Require independent MFA for this mailbox? yes/no',
    c.access.mfa ? 'yes' : 'no',
    (v) => {
      if (!['yes', 'no'].includes(v)) throw new Error('Enter yes or no');
    },
  );
  c.access.mfa = mfa === 'yes';
  const addresses = [];
  for (const d of domains.filter((d) => d.receiving)) {
    const locals = await ask(
      `Mailbox names at ${d.name}, comma-separated (e.g. hello,work)`,
      c.addresses
        .filter((a) => a.email.endsWith('@' + d.name))
        .map((a) => a.email.split('@')[0])
        .join(',') || 'hello',
      (v) => {
        for (const name of v.split(',').map((x) => x.trim()))
          configSchema.shape.addresses.unwrap().element.shape.email.parse(`${name}@${d.name}`);
      },
    );
    for (const local of [...new Set(locals.split(',').map((x) => x.trim().toLowerCase()))]) {
      const email = `${local}@${d.name}`,
        old = c.addresses.find((a) => a.email === email);
      addresses.push({
        email,
        name: old?.name || local,
        color: old?.color || '#8272d5',
        signature: old?.signature || '',
      });
    }
  }
  c.addresses = addresses;
  const team = await ask(
    'Access team domain (leave auto to discover existing Zero Trust)',
    c.access.teamDomain || 'auto',
    (v) => {
      if (v !== 'auto' && !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(v))
        throw new Error('Use TEAM.cloudflareaccess.com or auto');
    },
  );
  c.access.teamDomain = team === 'auto' ? '' : team;
  const result = configSchema.parse(c);
  validateLive(result);
  return result;
}
