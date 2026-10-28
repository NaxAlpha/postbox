import { beforeAll, describe, it, expect } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import {
  verifyIdentity,
  authenticate,
  checkMutation,
  safeHtml,
  emailHtml,
  HttpError,
} from '../src/server/security';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
});
const issuer = 'https://team.cloudflareaccess.com',
  aud = 'mailbox-aud';
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ email: 'owner@example.com', ...overrides })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience(aud)
    .setSubject('owner-id')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}
describe('Access trust boundary', () => {
  it('accepts a signed, explicitly allowed human identity', async () => {
    const user = await verifyIdentity(
      await token(),
      issuer,
      aud,
      ['owner@example.com'],
      async () => keys.publicKey,
    );
    expect(user.email).toBe('owner@example.com');
  });
  it('rejects a valid token for another application', async () => {
    await expect(
      verifyIdentity(
        await token(),
        issuer,
        'different-app',
        ['owner@example.com'],
        async () => keys.publicKey,
      ),
    ).rejects.toThrow('Access denied');
  });
  it('rejects an unlisted user and service identity', async () => {
    await expect(
      verifyIdentity(
        await token({ email: 'attacker@example.com' }),
        issuer,
        aud,
        ['owner@example.com'],
        async () => keys.publicKey,
      ),
    ).rejects.toThrow();
    await expect(
      verifyIdentity(
        await token({ type: 'service' }),
        issuer,
        aud,
        ['owner@example.com'],
        async () => keys.publicKey,
      ),
    ).rejects.toThrow();
  });
  it('rejects expired tokens and wrong issuers', async () => {
    const old = await new SignJWT({ email: 'owner@example.com' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience(aud)
      .setSubject('id')
      .setIssuedAt()
      .setExpirationTime(1)
      .sign(keys.privateKey);
    await expect(
      verifyIdentity(old, issuer, aud, ['owner@example.com'], async () => keys.publicKey),
    ).rejects.toThrow();
    await expect(
      verifyIdentity(
        await token(),
        'https://other.cloudflareaccess.com',
        aud,
        ['owner@example.com'],
        async () => keys.publicKey,
      ),
    ).rejects.toThrow();
  });
  it('rejects forged or missing assertions and empty configuration', async () => {
    await expect(
      verifyIdentity('fake', issuer, aud, ['owner@example.com'], async () => keys.publicKey),
    ).rejects.toThrow();
    await expect(
      verifyIdentity(await token(), issuer, '', [], async () => keys.publicKey),
    ).rejects.toThrow();
  });
  it('never enables local authentication on a public hostname', async () => {
    await expect(
      authenticate(new Request('https://public.example/api/bootstrap'), {
        DEV_MODE: 'local',
        APP_ORIGIN: '',
      } as Env),
    ).rejects.toThrow();
  });
  it('rejects cross-site mutations despite an authenticated session', () => {
    expect(() =>
      checkMutation(
        new Request('https://mail.example/api/drafts', {
          method: 'POST',
          headers: { Origin: 'https://evil.example', 'X-Postbox-Request': '1' },
        }),
        { email: 'owner@example.com', subject: 'id', local: false },
        { APP_ORIGIN: 'https://mail.example' } as Env,
      ),
    ).toThrow(HttpError);
  });
});
describe('untrusted email content', () => {
  it('removes scripts, handlers, forms, javascript links, external images, styles and frames', () => {
    const h = safeHtml(
      '<script>alert(1)</script><img src="https://track.example/pixel" onerror="steal()"><a href="javascript:alert(1)">x</a><iframe src="https://evil.example"></iframe><form>bad</form><div style="background:url(https://track.example)">safe</div>',
    );
    expect(h).not.toMatch(/<script|onerror|javascript:|<iframe|<form|style=|https:\/\/track/);
    expect(h).toContain('Remote image blocked');
  });
  it('only embeds registered inline attachments', () => {
    expect(safeHtml('<img src="cid:known"><img src="cid:missing">', { known: 'abc' })).toContain(
      '/api/attachments/abc',
    );
    expect(safeHtml('<img src="cid:missing">')).not.toContain('cid:');
  });
  it('encodes composed plaintext rather than treating it as HTML', () => {
    expect(emailHtml('<script>bad</script>')).toContain('&lt;script&gt;');
  });
});

it('handles discarded iframe recursion payload without stack overflow or active HTML', () => {
  const result = safeHtml('<iframe>'.repeat(4000));
  expect(result).not.toMatch(/<iframe|<script/i);
});
