import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../scripts/provider.mjs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  cf: vi.fn(),
  rawSql: vi.fn(),
}));
import { cf, rawSql } from '../scripts/provider.mjs';
import {
  BUCKET_MARKER,
  verifyBucketIdentity,
  createBucketIdentity,
  reconcileLegacyBucket,
} from '../scripts/bucket-ownership.mjs';
import { exportMail, restoreMail } from '../scripts/backup.mjs';
import { configSchema, names } from '../scripts/config.mjs';
let previous: string, root: string, c: any, m: any, bucket: any, marker: any;
beforeEach(() => {
  previous = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'postbox-bucket-security-'));
  process.chdir(root);
  c = configSchema.parse({
    ...JSON.parse(readFileSync(new URL('../mailbox.example.json', import.meta.url), 'utf8')),
    accountId: 'a'.repeat(32),
  });
  bucket = {
    kind: 'bucket',
    id: names(c).bucket,
    name: names(c).bucket,
    owned: true,
    accountId: c.accountId,
    installId: 'installation',
    bucketIdentity: { creationDate: '2026-10-14T00:00:00.000Z', marker: 'random-marker' },
  };
  m = {
    version: 1,
    accountId: c.accountId,
    prefix: c.resourcePrefix,
    installId: 'installation',
    resources: [bucket],
    routes: [],
    databaseId: 'database',
  };
  marker = {
    version: 1,
    accountId: c.accountId,
    installId: m.installId,
    bucket: bucket.name,
    ...bucket.bucketIdentity,
  };
  vi.clearAllMocks();
  vi.mocked(rawSql).mockReturnValue([]);
  vi.mocked(cf).mockImplementation((args: string[]) => {
    if (args.slice(0, 3).join(' ') === 'r2 buckets get')
      return { name: bucket.name, creation_date: '2026-10-14T00:00:00Z' };
    if (args[2] === 'get') return Buffer.from(JSON.stringify(marker));
    if (args[2] === 'list') return { objects: [{ key: BUCKET_MARKER }] };
    return {};
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(previous);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('refuses a replacement during initial creation before writing a marker', () => {
  expect(() =>
    createBucketIdentity(c, m, bucket.name, { creation_date: '2025-01-01T00:00:00Z' }),
  ).toThrow('changed during creation');
  expect(vi.mocked(cf).mock.calls.some(([a]) => a.includes('put'))).toBe(false);
});
it('requires both matching creation time and a readable installation marker', () => {
  expect(() => verifyBucketIdentity(c, m, bucket)).not.toThrow();
  marker.installId = 'other';
  expect(() => verifyBucketIdentity(c, m, bucket)).toThrow('does not match');
  vi.mocked(cf).mockImplementation((args: string[]) => {
    if (args[1] === 'buckets') return { name: bucket.name, creation_date: '2026-10-14T00:00:00Z' };
    throw Error('404');
  });
  expect(() => verifyBucketIdentity(c, m, bucket)).toThrow('marker is missing or unreadable');
});
it('excludes ownership markers from backups and permits restore into marker-only storage', () => {
  exportMail(c, m);
  const file = join('.postbox', readdirSync('.postbox')[0], 'backup.json');
  expect(JSON.parse(readFileSync(file, 'utf8')).objects).toEqual({});
  expect(vi.mocked(cf).mock.calls.some(([a]) => a[2] === 'get' && a[3] === BUCKET_MARKER)).toBe(
    false,
  );
  expect(() => restoreMail(c, m, file, true)).not.toThrow();
  vi.mocked(cf).mockImplementation((args: string[]) => {
    if (args[1] === 'buckets') return { name: bucket.name, creation_date: '2026-10-14T00:00:00Z' };
    if (args[2] === 'get') return Buffer.from(JSON.stringify(marker));
    return { objects: [{ key: BUCKET_MARKER }, { key: 'files/unrelated' }] };
  });
  expect(() => restoreMail(c, m, file, true)).toThrow('empty installation');
  marker.installId = 'foreign-installation';
  expect(() => restoreMail(c, m, file, true)).toThrow('marker does not match');
});

const auditId = '00000000-0000-4000-8000-000000000000';
function legacyAudit() {
  delete bucket.bucketIdentity;
  const event = {
    id: auditId,
    account: { id: c.accountId },
    action: { type: 'create', result: 'success', time: '2026-10-14T00:00:00Z' },
    resource: {
      product: 'r2',
      type: 'buckets',
      request: { name: bucket.name },
      response: { name: bucket.name },
    },
    raw: { method: 'POST', uri: `/accounts/${c.accountId}/r2/buckets` },
  };
  let stored: any;
  vi.mocked(cf).mockImplementation((args: string[], _c: any, body: any) => {
    if (args[0] === 'accounts') return [event];
    if (args[1] === 'buckets') return { name: bucket.name, creation_date: '2026-10-14T00:00:00Z' };
    if (args[2] === 'put') {
      stored = body;
      return {};
    }
    if (args[2] === 'get') {
      if (stored) return Buffer.from(JSON.stringify(stored));
      throw Error('404 Not Found');
    }
    throw Error('Unexpected ' + args.join(' '));
  });
  return {
    event,
    setMarker: (value: any) => {
      stored = value;
    },
  };
}
it('previews historical identity without writes, then applies with exact prefix and is repeatable', () => {
  legacyAudit();
  const persist = vi.fn();
  expect(reconcileLegacyBucket(c, m, { auditId }).status).toBe('verified-preview');
  expect(cf.mock.calls.some(([a]) => a.includes('put'))).toBe(false);
  expect(bucket.bucketIdentity).toBeUndefined();
  expect(
    reconcileLegacyBucket(c, m, { auditId, apply: true, confirmPrefix: c.resourcePrefix, persist })
      .status,
  ).toBe('reconciled');
  expect(persist).toHaveBeenCalledOnce();
  expect(
    reconcileLegacyBucket(c, m, { auditId, apply: true, confirmPrefix: c.resourcePrefix, persist })
      .status,
  ).toBe('already-verified');
  expect(persist).toHaveBeenCalledOnce();
});
it('requires confirmation before reading cloud state for reconciliation', () => {
  legacyAudit();
  expect(() =>
    reconcileLegacyBucket(c, m, { auditId, apply: true, confirmPrefix: 'wrong' }),
  ).toThrow('confirm-prefix');
  expect(cf).not.toHaveBeenCalled();
});
it.each(['account', 'name', 'timestamp', 'action', 'auditId'])(
  'rejects mismatched %s audit evidence without writes',
  (kind) => {
    const { event } = legacyAudit();
    if (kind === 'account') event.account.id = 'foreign';
    if (kind === 'name') event.resource.request.name = 'foreign';
    if (kind === 'timestamp') event.action.time = '2026-10-15T00:00:00Z';
    if (kind === 'action') event.action.type = 'view';
    if (kind === 'auditId') event.id = 'another-id';
    expect(() =>
      reconcileLegacyBucket(c, m, {
        auditId,
        apply: true,
        confirmPrefix: c.resourcePrefix,
        persist: vi.fn(),
      }),
    ).toThrow('does not prove');
    expect(cf.mock.calls.some(([a]) => a.includes('put'))).toBe(false);
  },
);
it('refuses missing audit history and foreign markers rather than adopting by name', () => {
  legacyAudit();
  expect(() => reconcileLegacyBucket(c, m, {})).toThrow('original Cloudflare');
  vi.mocked(cf).mockImplementation((args) =>
    args[0] === 'accounts' ? [] : { name: bucket.name, creation_date: '2026-10-14T00:00:00Z' },
  );
  expect(() => reconcileLegacyBucket(c, m, { auditId })).toThrow('unavailable or ambiguous');
  const { setMarker } = legacyAudit();
  setMarker({ ...marker, installId: 'foreign' });
  expect(() =>
    reconcileLegacyBucket(c, m, {
      auditId,
      apply: true,
      confirmPrefix: c.resourcePrefix,
      persist: vi.fn(),
    }),
  ).toThrow('foreign or invalid');
  expect(cf.mock.calls.some(([a]) => a.includes('put'))).toBe(false);
});

it.each([null, false, 0, ''])(
  'does not overwrite an existing invalid JSON marker value %s',
  (value) => {
    legacyAudit();
    const previous = vi.mocked(cf).getMockImplementation()!;
    vi.mocked(cf).mockImplementation((args, c, body) =>
      args[1] === 'objects' && args[2] === 'get'
        ? Buffer.from(JSON.stringify(value))
        : previous(args, c, body),
    );
    expect(() =>
      reconcileLegacyBucket(c, m, {
        auditId,
        apply: true,
        confirmPrefix: c.resourcePrefix,
        persist: vi.fn(),
      }),
    ).toThrow('foreign or invalid');
    expect(cf.mock.calls.some(([a]) => a.includes('put'))).toBe(false);
  },
);
it('recovers a previously written own marker without replacing it after an interrupted manifest save', () => {
  const { setMarker } = legacyAudit();
  const known = '11111111-1111-4111-8111-111111111111';
  setMarker({ ...marker, marker: known });
  const persist = vi.fn();
  reconcileLegacyBucket(c, m, { auditId, apply: true, confirmPrefix: c.resourcePrefix, persist });
  expect(bucket.bucketIdentity.marker).toBe(known);
  expect(cf.mock.calls.some(([a]) => a.includes('put'))).toBe(false);
});
