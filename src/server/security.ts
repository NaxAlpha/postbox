import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import sanitizeHtml from 'sanitize-html';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Identity {
  email: string;
  subject: string;
  local: boolean;
}
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyIdentity(
  token: string,
  issuer: string,
  audience: string,
  allowed: string[],
  keys?: JWTVerifyGetKey,
): Promise<Identity> {
  if (!issuer || !audience || !allowed.length)
    throw new HttpError(403, 'Mailbox authentication is not configured');
  if (!keys) {
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer))
      throw new HttpError(403, 'Invalid Access team domain');
    if (!jwksCache.has(issuer))
      jwksCache.set(
        issuer,
        createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
          timeoutDuration: 5000,
          cooldownDuration: 30000,
        }),
      );
    keys = jwksCache.get(issuer)!;
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    if (
      typeof payload.email !== 'string' ||
      typeof payload.sub !== 'string' ||
      !allowed.includes(payload.email.toLowerCase()) ||
      payload.type === 'service'
    )
      throw new Error('Not an allowed user');
    return { email: payload.email.toLowerCase(), subject: payload.sub, local: false };
  } catch {
    throw new HttpError(403, 'Access denied');
  }
}
export async function authenticate(request: Request, env: Env): Promise<Identity> {
  const url = new URL(request.url);
  if (
    env.DEV_MODE === 'local' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.protocol === 'http:'
  )
    return { email: 'owner@example.test', subject: 'local-owner', local: true };
  if (!env.APP_ORIGIN || url.origin !== env.APP_ORIGIN)
    throw new HttpError(403, 'Unexpected application origin');
  const allowed: unknown = JSON.parse(env.ALLOWED_USERS || '[]');
  if (!Array.isArray(allowed) || allowed.some((x) => typeof x !== 'string'))
    throw new HttpError(403, 'Invalid user configuration');
  return verifyIdentity(
    request.headers.get('Cf-Access-Jwt-Assertion') || '',
    env.ACCESS_ISSUER,
    env.ACCESS_AUD,
    allowed.map((x) => x.toLowerCase()),
  );
}
export function checkMutation(request: Request, identity: Identity, env: Env) {
  if (['GET', 'HEAD'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  const expected = identity.local ? new URL(request.url).origin : env.APP_ORIGIN;
  if (origin !== expected || request.headers.get('X-Postbox-Request') !== '1')
    throw new HttpError(403, 'Request origin could not be verified');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
    throw new HttpError(403, 'Cross-site request denied');
}
export function safeHtml(html: string, cidMap: Record<string, string> = {}) {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'div',
      'span',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'blockquote',
      'pre',
      'code',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'hr',
      'a',
      'img',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
    },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: 'a',
        attribs: { ...attrs, target: '_blank', rel: 'noopener noreferrer' },
      }),
      img: (_tag, attrs): sanitizeHtml.Tag => {
        const src = attrs.src || '';
        const id = src.startsWith('cid:') ? cidMap[src.slice(4)] : undefined;
        return id
          ? { tagName: 'img', attribs: { src: `/api/attachments/${id}`, alt: attrs.alt || '' } }
          : {
              tagName: 'span',
              attribs: {},
              text: attrs.alt ? `[Image: ${attrs.alt}]` : '[Remote image blocked]',
            };
      },
    },
  });
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export function emailHtml(text: string) {
  return `<div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}
export function sanitizeFilename(s: string) {
  return s.replace(/[\r\n\x00-\x1f\\/]/g, '_').slice(0, 180) || 'attachment';
}
export async function boundedBody(request: Request, max: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, 'Upload exceeds size limit');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return body;
}
export async function jsonBody(request: Request) {
  const bytes = await boundedBody(request, 1024 * 1024);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
export function securityHeaders() {
  return {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  };
}
