import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { cf, rows, rawSql } from './provider.mjs';
import { BUCKET_MARKER, verifyBucketIdentity } from './bucket-ownership.mjs';
import { names, validateManifest } from './config.mjs';
export const tables = [
  'addresses',
  'labels',
  'contacts',
  'rules',
  'settings',
  'messages',
  'attachments',
  'intakes',
  'outbox',
  'send_quota',
  'delivery_events',
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function exportMail(c, m) {
  validateManifest(m, c);
  const dir = resolve('.postbox', `export-${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = {
    format: 'postbox-backup-v1',
    createdAt: new Date().toISOString(),
    tables: {},
    objects: {},
  };
  for (const table of tables) {
    const records = [];
    for (let offset = 0; ; offset += 500) {
      const page = rows(
        rawSql(c, m, `SELECT * FROM ${table} ORDER BY rowid LIMIT 500 OFFSET ?`, [offset]),
      );
      records.push(...page);
      if (page.length < 500) break;
    }
    data.tables[table] = records;
  }
  let cursor = '',
    index = 0;
  const seen = new Set();
  do {
    const page = cf(
      [
        'r2',
        'objects',
        'list',
        '--bucket-name',
        names(c).bucket,
        '--per-page',
        '1000',
        ...(cursor ? ['--cursor', cursor] : []),
      ],
      c,
    );
    for (const object of rows(page)) {
      if (object.key === BUCKET_MARKER) continue;
      const file = `object-${index++}.bin`,
        bytes = cf(
          ['r2', 'objects', 'get', object.key, '--bucket-name', names(c).bucket],
          c,
          undefined,
          true,
        );
      writeFileSync(resolve(dir, file), bytes, { mode: 0o600 });
      data.objects[object.key] = { file, sha256: digest(bytes) };
    }
    cursor = page.cursor || page.result_info?.cursor || '';
    if (
      ((page.is_truncated || page.truncated || page.isTruncated || rows(page).length >= 1000) &&
        !cursor) ||
      (seen.has(cursor) && cursor)
    )
      throw new Error('Invalid R2 pagination; backup is incomplete');
    seen.add(cursor);
  } while (cursor);
  writeFileSync(resolve(dir, 'backup.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(
    `Export saved to ${dir}. It contains private mail. Pause receiving and drain queues for a consistent snapshot; live exports may contain concurrent changes.`,
  );
}
export function validateBackup(file) {
  const root = realpathSync(dirname(file)),
    data = JSON.parse(readFileSync(file, 'utf8'));
  if (
    data.format !== 'postbox-backup-v1' ||
    !data.tables ||
    !data.objects ||
    Object.keys(data.tables).some((t) => !tables.includes(t))
  )
    throw new Error('Invalid backup format');
  for (const table of tables)
    if (!Array.isArray(data.tables[table])) throw new Error(`Backup is missing ${table}`);
  for (const [key, object] of Object.entries(data.objects)) {
    if (
      !/^(raw\/|bodies\/|files\/|outbox\/)[a-zA-Z0-9._/-]+$/.test(key) ||
      key.includes('..') ||
      !/^object-\d+\.bin$/.test(object.file)
    )
      throw new Error('Unsafe backup object path');
    const path = realpathSync(resolve(root, object.file));
    if (!path.startsWith(root + sep)) throw new Error('Backup object is outside its directory');
    if (digest(readFileSync(path)) !== object.sha256)
      throw new Error(`Backup checksum mismatch: ${object.file}`);
  }
  for (const message of data.tables.messages)
    for (const key of [message.body_key, message.raw_key].filter(Boolean))
      if (!data.objects[key]) throw new Error('Backup is missing a message object');
  for (const attachment of data.tables.attachments)
    if (!data.objects[attachment.object_key]) throw new Error('Backup is missing an attachment');
  return { data, root };
}
export function restoreMail(c, m, file, apply) {
  validateManifest(m, c);
  const { data, root } = validateBackup(resolve(file));
  console.log(
    JSON.stringify(
      {
        restoreInto: names(c).database,
        records: Object.fromEntries(tables.map((t) => [t, data.tables[t].length])),
        objects: Object.keys(data.objects).length,
      },
      null,
      2,
    ),
  );
  if (!apply) return;
  verifyBucketIdentity(
    c,
    m,
    m.resources.find((r) => r.kind === 'bucket' && r.owned),
  );
  if (
    rows(rawSql(c, m, 'SELECT count(*) count FROM messages'))[0]?.count ||
    rows(rawSql(c, m, 'SELECT count(*) count FROM addresses'))[0]?.count ||
    rows(
      cf(['r2', 'objects', 'list', '--bucket-name', names(c).bucket, '--per-page', '2'], c),
    ).filter((object) => object.key !== BUCKET_MARKER).length
  )
    throw new Error(
      'Restore requires a new empty installation. Do not configure initial addresses or mail routes until restore finishes.',
    );
  // Validate all column names before uploading, then insert bound values only.
  const columns = Object.fromEntries(
    tables.map((t) => [
      t,
      new Set(rows(rawSql(c, m, `PRAGMA table_info(${t})`)).map((x) => x.name)),
    ]),
  );
  for (const table of tables)
    for (const record of data.tables[table])
      if (Object.keys(record).some((k) => !columns[table].has(k)))
        throw new Error('Backup schema is newer than this project');
  for (const [key, object] of Object.entries(data.objects))
    cf(
      [
        'r2',
        'objects',
        'put',
        key,
        '--bucket-name',
        names(c).bucket,
        '--file',
        resolve(root, object.file),
      ],
      c,
    );
  for (const table of tables)
    for (const original of data.tables[table]) {
      const record = { ...original };
      if (table === 'outbox' && ['queued', 'processing'].includes(record.status)) {
        record.status = 'unknown';
        record.error = 'Restored pending submission; inspect provider logs before resolving';
      }
      if (
        table === 'messages' &&
        record.direction === 'outbound' &&
        ['queued', 'processing'].includes(record.status)
      ) {
        record.status = 'unknown';
        record.error = 'Restored pending submission; inspect provider logs before resolving';
      }
      if (
        table === 'settings' &&
        (record.key.startsWith('route:') ||
          record.key.startsWith('gc:') ||
          record.key === 'raw-recovery-cursor')
      )
        continue;
      const keys = Object.keys(record);
      rawSql(
        c,
        m,
        `INSERT OR REPLACE INTO ${table}(${keys.map((k) => `"${k}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        keys.map((k) => record[k]),
      );
    }
  console.log(
    'Restored mail. Pending outbound submissions are uncertain and will not be sent automatically. Configure receiving routes only after checking the restored mailbox.',
  );
}
