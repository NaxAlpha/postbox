import { readFileSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const clean = (value) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export function mailboxOrigin(config, local) {
  if (!local) {
    if (
      typeof config.hostname !== 'string' ||
      config.hostname.length > 253 ||
      !/^[a-z0-9.-]+$/.test(config.hostname) ||
      !config.hostname.includes('.') ||
      config.hostname
        .split('.')
        .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      throw new CliError(
        'INVALID_ORIGIN',
        'Configure a canonical mailbox DNS hostname with postbox init',
      );
    return new URL(`https://${config.hostname}`).origin;
  }
  const url = new URL(local === true ? 'http://127.0.0.1:5173' : local);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new CliError('INVALID_LOCAL_URL', '--local-url must be an HTTP loopback origin');
  return url.origin;
}
export function accessToken(origin, env = process.env) {
  let token = env.POSTBOX_ACCESS_TOKEN;
  if (!token && existsSync('.postbox/access-token.json')) {
    try {
      const saved = JSON.parse(readFileSync('.postbox/access-token.json', 'utf8'));
      if (saved.origin === origin) token = saved.token;
    } catch {
      throw new CliError('AUTH_REQUIRED', 'Unreadable Access session. Run postbox auth again.');
    }
  }
  if (!token || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
    throw new CliError(
      'AUTH_REQUIRED',
      'Run postbox auth in a terminal, or supply POSTBOX_ACCESS_TOKEN with a human Cloudflare Access JWT.',
    );
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (!payload.exp || payload.exp * 1000 <= Date.now()) throw Error();
  } catch {
    throw new CliError(
      'AUTH_REQUIRED',
      'Access session expired or invalid. Run postbox auth again.',
    );
  }
  return token;
}
export function loginMailbox(origin) {
  const cli = resolve('node_modules/cf/bin/cf');
  execFileSync(process.execPath, [cli, 'access', 'login', origin], {
    stdio: ['inherit', 'ignore', 'inherit'],
  });
  let token;
  try {
    token = execFileSync(process.execPath, [cli, 'access', 'token', origin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
    accessToken(origin, { POSTBOX_ACCESS_TOKEN: token });
  } catch {
    throw new CliError(
      'AUTH_REQUIRED',
      'Could not retrieve an Access JWT. Check cf/cloudflared installation and sign in again.',
    );
  }
  mkdirSync('.postbox', { recursive: true, mode: 0o700 });
  writeFileSync('.postbox/access-token.json', JSON.stringify({ origin, token }), { mode: 0o600 });
  chmodSync('.postbox/access-token.json', 0o600);
}
export function createMailClient(origin, { local = false, token, fetchImpl = fetch } = {}) {
  return async (path, method = 'GET', body) => {
    if (!path.startsWith('/api/') || path.includes('://'))
      throw new CliError('INVALID_PATH', 'Invalid mailbox API path');
    let response;
    try {
      response = await fetchImpl(new URL(path, origin), {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: 'application/json',
          Origin: origin,
          'X-Postbox-Request': '1',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(!local && token ? { Cookie: `CF_Authorization=${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(
        'NETWORK_ERROR',
        method === 'GET'
          ? 'Mailbox request failed. Check connectivity.'
          : 'Request outcome is unknown. Inspect the mailbox before retrying; no automatic retry was made.',
      );
    }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status))
      throw new CliError(
        'AUTH_REQUIRED',
        'Mailbox access denied. Run postbox auth and check the allowed login email.',
      );
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new CliError('INVALID_RESPONSE', 'Mailbox returned an unexpected response');
    const data = await response.json();
    if (!response.ok)
      throw new CliError(`HTTP_${response.status}`, clean(data.error || 'Mailbox request failed'));
    return data;
  };
}
export function messageId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || ''))
    throw new CliError('INVALID_ID', 'A message UUID is required (--id=UUID)');
  return value;
}
export function resolveAddress(addresses, value, sending = false) {
  const found = addresses.find(
    (a) => a.email.toLowerCase() === value?.toLowerCase() || a.id === value,
  );
  if (!found || !found.enabled || (sending && !found.send_enabled))
    throw new CliError(
      'INVALID_ADDRESS',
      'Choose an enabled configured mailbox address' + (sending ? ' with sending enabled' : ''),
    );
  return found;
}
export function displayMessage(m) {
  return clean(
    `ID: ${m.id}\nStatus: ${m.status} | Folder: ${m.folder}\nMailbox: ${m.address_email || m.address_id}\nFrom: ${m.from_address}\nTo: ${m.to_json}\nCc: ${m.cc_json || '[]'}\nBcc: ${m.bcc_json || '[]'}\nSubject: ${m.subject}\n\n${m.text || m.snippet || ''}\n\nAttachments: ${(m.attachments || []).map((a) => `${a.filename} (${a.id})`).join(', ') || 'none'}`,
  );
}
