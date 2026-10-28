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
      'Bucket ownership metadata is missing (legacy installation). Refusing mail deletion; use --keep-mail until the original bucket ownership has been explicitly reconciled.',
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
