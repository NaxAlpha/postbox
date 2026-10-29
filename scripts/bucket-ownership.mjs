import { randomUUID } from 'node:crypto';
import { cf } from './provider.mjs';
export const BUCKET_MARKER = '__postbox/ownership.json';
function creationDate(bucket) {
  const value = bucket?.creation_date;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('R2 bucket creation metadata is missing; refusing to assume ownership');
  return new Date(value).toISOString();
}
export function createBucketIdentity(c, m, name, created) {
  const live = cf(['r2', 'buckets', 'get', name], c);
  if (live?.name !== name) throw new Error('R2 bucket name differs from the installation');
  const createdAt = creationDate(created);
  if (creationDate(live) !== createdAt)
    throw new Error('R2 bucket changed during creation; refusing ownership');
  const identity = { creationDate: createdAt, marker: randomUUID() };
  const body = {
    version: 1,
    accountId: c.accountId,
    installId: m.installId,
    bucket: name,
    ...identity,
  };
  cf(
    [
      'r2',
      'objects',
      'put',
      BUCKET_MARKER,
      '--bucket-name',
      name,
      '--content-type',
      'application/json',
    ],
    c,
    body,
  );
  return identity;
}
export function verifyBucketIdentity(c, m, resource) {
  if (!resource?.bucketIdentity?.creationDate || !resource.bucketIdentity.marker)
    throw new Error(
      'Bucket ownership metadata is missing (legacy installation). Refusing mail deletion. Run postbox reconcile-bucket --audit-id=ORIGINAL_CREATION_UUID to preview original audit evidence, then apply with --confirm-prefix. If evidence is unavailable, use --keep-mail.',
    );
  const live = cf(['r2', 'buckets', 'get', resource.name], c);
  if (live?.name !== resource.name || creationDate(live) !== resource.bucketIdentity.creationDate)
    throw new Error('R2 bucket was replaced or its creation identity changed; refusing deletion');
  let marker;
  try {
    marker = JSON.parse(
      cf(
        ['r2', 'objects', 'get', BUCKET_MARKER, '--bucket-name', resource.name],
        c,
        undefined,
        true,
      ).toString('utf8'),
    );
  } catch {
    throw new Error('R2 ownership marker is missing or unreadable; refusing deletion');
  }
  if (
    marker.version !== 1 ||
    marker.accountId !== c.accountId ||
    marker.installId !== m.installId ||
    marker.bucket !== resource.name ||
    marker.creationDate !== resource.bucketIdentity.creationDate ||
    marker.marker !== resource.bucketIdentity.marker
  )
    throw new Error('R2 ownership marker does not match this installation; refusing deletion');
}

// An operator must identify the ORIGINAL creation audit entry, not just a bucket name.
// A recreated bucket has a different creation timestamp and cannot match that event.
export function reconcileLegacyBucket(
  c,
  m,
  { auditId, apply = false, confirmPrefix, persist } = {},
) {
  if (apply && confirmPrefix !== c.resourcePrefix)
    throw new Error('Bucket reconciliation requires --confirm-prefix matching this installation');
  const resource = m.resources.find((r) => r.kind === 'bucket' && r.owned);
  if (!resource) throw new Error('There is no owned bucket to reconcile');
  if (resource.bucketIdentity) {
    verifyBucketIdentity(c, m, resource);
    return { bucket: resource.name, status: 'already-verified' };
  }
  if (!/^[a-f0-9-]{32,36}$/i.test(auditId || ''))
    throw new Error(
      'Legacy bucket requires the original Cloudflare creation --audit-id=UUID. Preview with reconcile-bucket; use --keep-mail if historical evidence is unavailable.',
    );
  const live = cf(['r2', 'buckets', 'get', resource.name], c);
  const date = creationDate(live);
  if (
    live.name !== resource.name ||
    resource.id !== resource.name ||
    resource.accountId !== c.accountId ||
    resource.installId !== m.installId
  )
    throw new Error('Bucket ownership record differs from the installation');
  const time = Date.parse(date);
  const events = cf(
    [
      'accounts',
      'logs',
      'audit',
      'list',
      '--audit-log-id',
      auditId,
      '--since',
      new Date(time - 60000).toISOString(),
      '--before',
      new Date(time + 60000).toISOString(),
      '--limit',
      '2',
    ],
    c,
  );
  if (!Array.isArray(events) || events.length !== 1)
    throw new Error(
      'Original bucket creation audit evidence is unavailable or ambiguous; refusing reconciliation',
    );
  const event = events[0];
  if (
    event.id !== auditId ||
    event.account?.id !== c.accountId ||
    event.action?.type !== 'create' ||
    event.action?.result !== 'success' ||
    event.resource?.product !== 'r2' ||
    event.resource?.type !== 'buckets' ||
    event.resource?.request?.name !== resource.name ||
    event.resource?.response?.name !== resource.name ||
    event.raw?.method !== 'POST' ||
    event.raw?.uri !== `/accounts/${c.accountId}/r2/buckets` ||
    !Number.isFinite(Date.parse(event.action?.time)) ||
    Math.abs(time - Date.parse(event.action.time)) > 5000
  )
    throw new Error(
      'Audit entry does not prove this original bucket creation; refusing reconciliation',
    );
  let existing;
  let hasMarker = false;
  try {
    existing = JSON.parse(
      cf(
        ['r2', 'objects', 'get', BUCKET_MARKER, '--bucket-name', resource.name],
        c,
        undefined,
        true,
      ).toString('utf8'),
    );
    hasMarker = true;
  } catch (error) {
    if (!/404 Not Found/.test((error.stderr?.toString() || '') + ' ' + error.message))
      throw new Error('Cannot verify whether a bucket ownership marker already exists');
  }
  if (
    hasMarker &&
    (!existing ||
      typeof existing !== 'object' ||
      Array.isArray(existing) ||
      existing.version !== 1 ||
      existing.installId !== m.installId ||
      existing.accountId !== c.accountId ||
      existing.bucket !== resource.name ||
      existing.creationDate !== date ||
      !/^[a-f0-9-]{36}$/i.test(existing.marker || ''))
  )
    throw new Error('Bucket has a foreign or invalid ownership marker; refusing overwrite');
  const plan = {
    bucket: resource.name,
    creationDate: date,
    auditId,
    status: apply ? 'reconciled' : 'verified-preview',
  };
  if (!apply) return plan;
  if (typeof persist !== 'function')
    throw new Error('A private manifest writer is required for reconciliation');
  resource.bucketIdentity = existing
    ? { creationDate: date, marker: existing.marker }
    : createBucketIdentity(c, m, resource.name, live);
  resource.ownershipReconciliation = {
    at: new Date().toISOString(),
    auditId,
    actionTime: event.action.time,
  };
  persist(m);
  verifyBucketIdentity(c, m, resource);
  return plan;
}
