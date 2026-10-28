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
