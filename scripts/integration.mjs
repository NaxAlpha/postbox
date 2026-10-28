import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = await build({
  entryPoints: ['tests/integration-entry.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  external: ['cloudflare:email', 'cloudflare:workers'],
  plugins: [
    {
      name: 'raw-sql',
      setup(b) {
        b.onResolve({ filter: /\.sql\?raw$/ }, (a) => ({
          path: new URL(a.path.slice(0, -4), `file://${a.resolveDir}/`).pathname,
          namespace: 'raw',
        }));
        b.onLoad({ filter: /.*/, namespace: 'raw' }, async (a) => ({
          contents: `export default ${JSON.stringify(await readFile(a.path, 'utf8'))}`,
          loader: 'js',
        }));
      },
    },
  ],
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: output.outputFiles[0].text,
    compatibilityDate: '2026-10-13',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'integration' },
    r2Buckets: { MAIL: 'integration' },
    queueProducers: { JOBS: 'jobs' },
    bindings: {
      DEV_MODE: 'local',
      APP_ORIGIN: '',
      ACCESS_ISSUER: '',
      ACCESS_AUD: '',
      ALLOWED_USERS: '[]',
      DOMAINS: '[]',
      INITIAL_ADDRESSES: '[]',
      RESOURCE_PREFIX: 'test',
      WORKER_NAME: 'test-app',
      SEND_LIMIT: '100',
      TRASH_DAYS: '30',
      SPAM_DAYS: '30',
      ROUTING_TOKEN: '',
    },
  }),
);
async function call(path, method = 'GET', body) {
  const r = await mf.dispatchFetch(`http://localhost${path}`, {
    method,
    headers: {
      Origin: 'http://localhost',
      'X-Postbox-Request': '1',
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (r.status >= 400) throw new Error(`${r.status}: ${JSON.stringify(data)}`);
  return data;
}
try {
  const boot = await call('/api/bootstrap');
  assert.equal(boot.addresses.length, 3);
  const catchAllBoot = await call('/__test/config/bootstrap?mode=catch-all');
  assert.equal(catchAllBoot.domains[0].addressCreation, 'catch-all');
  const cliBoot = await call('/__test/config/bootstrap');
  assert.equal(cliBoot.domains[0].addressCreation, 'cli');
  assert.equal(
    (await call('/__test/config/bootstrap?mode=managed-route')).domains[0].addressCreation,
    'managed-route',
  );
  const unavailable = await mf.dispatchFetch('http://localhost/__test/config/addresses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'blocked@studio.example', name: 'Blocked' }),
  });
  assert.equal(unavailable.status, 409);
  assert.equal(
    await (
      await mf.getD1Database('DB')
    )
      .prepare("SELECT id FROM addresses WHERE email='blocked@studio.example'")
      .first(),
    null,
  );
  const created = await call('/__test/config/addresses?mode=catch-all', 'POST', {
    email: 'catch-all-test@studio.example',
    name: 'Catch all test',
  });
  assert.equal(created.email, 'catch-all-test@studio.example');
  const { executeMail } = await import('./mail-commands.mjs');
  const cliContext = {
    api: call,
    interactive: false,
    ask: async () => {
      throw Error('Unexpected prompt');
    },
  };
  const cliDraft = await executeMail(
    'draft',
    {
      from: boot.addresses[1].email,
      to: ['review@example.test'],
      subject: 'Agent review',
      body: 'Human review required',
    },
    [],
    cliContext,
  );
  assert.equal((await executeMail('view', { id: cliDraft.id }, [], cliContext)).folder, 'draft');
  const cliList = await executeMail('list', { folder: 'draft' }, [], cliContext);
  assert(cliList.messages.some((m) => m.id === cliDraft.id));
  const cliSend = await executeMail('send', { id: cliDraft.id, yes: true }, [], cliContext);
  assert.equal(cliSend.messageId, cliDraft.id);
  assert.equal(cliSend.status, 'queued');
  await call(`/api/messages/${cliDraft.id}/undo`, 'POST', {});
  const poisonHtml = `From: sender@example.test\r\nTo: ${boot.addresses[0].email}\r\nSubject: Sanitizer security regression\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${'<iframe>'.repeat(2000)}`;
  const htmlIntake = await call(
    `/__test/email?from=sender@example.test&to=${encodeURIComponent(boot.addresses[0].email)}`,
    'POST',
    poisonHtml,
  );
  assert.equal(htmlIntake.rejected, '');
  const htmlResult = await call('/api/messages?q=Sanitizer%20security%20regression');
  assert.equal(htmlResult.messages.length, 1);
  assert(!/<iframe/i.test((await call(`/api/messages/${htmlResult.messages[0].id}`)).html));
  const encodedSub = () =>
    `From: sender@example.test\r\nSubject: ${'=?utf-8?B?QUJD?='.repeat(12000)}\r\n\r\nBody`;
  const nestedHeaders = `From: sender@example.test\r\nContent-Type: multipart/mixed; boundary=budget\r\n\r\n${[1, 2].map(() => `--budget\r\nContent-Type: message/rfc822\r\nContent-Disposition: inline\r\n\r\n${encodedSub()}\r\n`).join('')}--budget--\r\n`;
  const budgetIntake = await call(
    `/__test/email?defer=1&from=sender@example.test&to=${encodeURIComponent(boot.addresses[0].email)}`,
    'POST',
    nestedHeaders,
  );
  assert.equal(
    (await call(`/__test/ingest?id=${budgetIntake.intakeIds[0]}`, 'POST', {})).ok,
    false,
  );
  const budgetDb = await mf.getD1Database('DB');
  assert.equal(
    (
      await budgetDb
        .prepare('SELECT status FROM intakes WHERE id=?')
        .bind(budgetIntake.intakeIds[0])
        .first()
    ).status,
    'pending',
  );
  const rejectedRaw = await budgetDb
    .prepare('SELECT raw_key FROM intakes WHERE id=?')
    .bind(budgetIntake.intakeIds[0])
    .first();
  await (await mf.getR2Bucket('MAIL')).delete(rejectedRaw.raw_key);
  await budgetDb.prepare('DELETE FROM intakes WHERE id=?').bind(budgetIntake.intakeIds[0]).run();
  const a = boot.addresses[1];
  const draft = await call('/api/drafts', 'POST', {
    addressId: a.id,
    to: ['recipient@example.test'],
    cc: [],
    bcc: ['private@example.test'],
    subject: 'Integration message',
    text: 'Hello integration',
    attachments: [],
  });
  const saved = await call(`/api/messages/${draft.id}`);
  assert.equal(saved.address_email, a.email);
  assert.equal(saved.folder, 'draft');
  const conflicting = await mf.dispatchFetch('http://localhost/api/drafts', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      'X-Postbox-Request': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: draft.id,
      revision: 0,
      addressId: a.id,
      to: [],
      cc: [],
      bcc: [],
      subject: 'Stale',
      text: 'Stale tab',
      attachments: [],
    }),
  });
  assert.equal(conflicting.status, 409);
  assert.equal((await call(`/api/messages/${draft.id}`)).subject, 'Integration message');
  const staleSend = await mf.dispatchFetch(`http://localhost/api/messages/${draft.id}/send`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      'X-Postbox-Request': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ revision: 0 }),
  });
  assert.equal(staleSend.status, 409);
  assert.equal((await call(`/api/messages/${draft.id}`)).folder, 'draft');
  const missingRevision = await mf.dispatchFetch(`http://localhost/api/messages/${draft.id}/send`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      'X-Postbox-Request': '1',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(missingRevision.status, 400);
  assert.equal((await call(`/api/messages/${draft.id}`)).folder, 'draft');
  const concurrent = await call('/api/drafts', 'POST', {
    addressId: a.id,
    to: ['reviewed@example.test'],
    cc: [],
    bcc: [],
    subject: 'Concurrency security',
    text: 'Reviewed',
    attachments: [],
  });
  const changed = await call('/api/drafts', 'POST', {
    id: concurrent.id,
    revision: concurrent.revision,
    addressId: a.id,
    to: ['changed@example.test'],
    cc: [],
    bcc: [],
    subject: 'Concurrency security',
    text: 'Changed',
    attachments: [],
  });
  const rejectedConcurrent = await mf.dispatchFetch(
    `http://localhost/api/messages/${concurrent.id}/send`,
    {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'X-Postbox-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ revision: concurrent.revision }),
    },
  );
  assert.equal(rejectedConcurrent.status, 409);
  assert.equal((await call(`/api/messages/${concurrent.id}`)).revision, changed.revision);
  assert.equal(
    await (
      await mf.getD1Database('DB')
    )
      .prepare('SELECT id FROM outbox WHERE message_id=?')
      .bind(concurrent.id)
      .first(),
    null,
  );
  const sent = await call(`/api/messages/${draft.id}/send`, 'POST', { revision: draft.revision });
  const duplicate = await call(`/api/messages/${draft.id}/send`, 'POST', {});
  assert.equal(duplicate.id, sent.id);
  await call(`/api/messages/${draft.id}/undo`, 'POST', {});
  assert.equal((await call(`/api/messages/${draft.id}`)).folder, 'draft');
  const db = await mf.getD1Database('DB');
  const sentAgain = await call(`/api/messages/${draft.id}/send`, 'POST', {
    revision: draft.revision,
  });
  await db
    .prepare('UPDATE outbox SET due_at=? WHERE id=?')
    .bind('2000-01-01T00:00:00.000Z', sentAgain.id)
    .run();
  await call(`/__test/send?id=${sentAgain.id}`, 'POST', {});
  assert.equal((await call(`/api/messages/${draft.id}`)).status, 'simulated');
  const raw = `From: Sender <sender@example.test>\r\nTo: ${a.email}\r\nMessage-ID: <integration-original@example.test>\r\nReply-To: replies@example.test\r\nSubject: Inbound integration\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA real MIME message handled in workerd.`;
  const incoming = await call(
    `/__test/email?from=sender@example.test&to=${encodeURIComponent(a.email)}`,
    'POST',
    raw,
  );
  assert.equal(incoming.rejected, '');
  await call(
    `/__test/email?from=sender@example.test&to=${encodeURIComponent(a.email)}`,
    'POST',
    raw,
  );
  const inbox = await call(`/api/messages?address=${a.id}&q=integration`);
  assert.equal(inbox.messages.length, 1);
  const m = inbox.messages[0];
  assert.deepEqual(JSON.parse(m.reply_to_json), ['replies@example.test']);
  const reply = await call('/api/drafts', 'POST', {
    addressId: a.id,
    to: ['sender@example.test'],
    cc: [],
    bcc: [],
    subject: 'Re: Inbound integration',
    text: 'Reply from the receiving mailbox',
    attachments: [],
    replyToMessageId: m.id,
  });
  assert.equal((await call(`/api/messages/${reply.id}`)).thread_id, m.thread_id);
  const invalid = await mf.dispatchFetch('http://localhost/api/drafts', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      'X-Postbox-Request': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      addressId: boot.addresses[0].id,
      to: ['sender@example.test'],
      cc: [],
      bcc: [],
      subject: 'Wrong identity',
      text: 'No',
      attachments: [],
      replyToMessageId: m.id,
    }),
  });
  assert.equal(invalid.status, 400);
  const unknown = await call(
    '/__test/email?from=sender@example.test&to=unknown@studio.example',
    'POST',
    raw,
  );
  assert.match(unknown.rejected, /not configured/);
  await call(`/api/addresses/${a.id}`, 'PATCH', { enabled: false });
  const paused = await call(
    `/__test/email?from=sender@example.test&to=${encodeURIComponent(a.email)}`,
    'POST',
    raw,
  );
  assert.match(paused.rejected, /not configured/);
  await call(`/api/messages/${m.id}`, 'PATCH', { folder: 'trash' });
  const trash = await call(`/api/messages/${m.id}/thread`);
  assert.ok(trash.messages.some((x) => x.id === m.id));
  await call(`/api/messages/${m.id}`, 'DELETE');
  assert.equal((await call(`/api/messages?folder=trash&address=${a.id}`)).total, 0);
  const upload = await mf.dispatchFetch(
    `http://localhost/api/attachments?address=${boot.addresses[0].id}`,
    {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'X-Postbox-Request': '1',
        'X-Filename': 'note.txt',
        'Content-Type': 'text/plain',
      },
      body: 'An attachment',
    },
  );
  const file = await upload.json();
  assert.equal(upload.status, 201);
  const prepared = await call('/api/drafts', 'POST', {
    addressId: boot.addresses[0].id,
    to: ['one@example.test'],
    cc: ['two@example.test'],
    bcc: [],
    subject: 'Transport contract',
    text: 'Contract',
    attachments: [file.id],
  });
  const job = await call(`/api/messages/${prepared.id}/send`, 'POST', {
    revision: prepared.revision,
  });
  await db
    .prepare('UPDATE outbox SET due_at=? WHERE id=?')
    .bind('2000-01-01T00:00:00Z', job.id)
    .run();
  const transport = await call(`/__test/send?id=${job.id}&provider=provider-test`, 'POST', {});
  assert.equal(transport.payload.from.email, boot.addresses[0].email);
  assert.deepEqual(transport.payload.cc, ['two@example.test']);
  assert.equal(transport.payload.attachments[0].filename, 'note.txt');
  const copy = await call('/api/attachments/copy', 'POST', {
    messageId: prepared.id,
    addressId: boot.addresses[0].id,
  });
  assert.equal(copy.attachments[0].filename, 'note.txt');
  assert.notEqual(copy.attachments[0].id, file.id);
  const event = (id, recipient, status, time) => ({
    type: `cf.email.sending.message.${status}`,
    source: { type: 'email.sending', zoneId: 'a'.repeat(32), domain: 'studio.example' },
    payload: { eventId: id, messageId: 'provider-test', recipient },
    metadata: { eventTimestamp: time },
  });
  await call(
    '/__test/event',
    'POST',
    event('e1', 'one@example.test', 'delivered', '2026-10-14T00:01:00Z'),
  );
  assert.equal((await call(`/api/messages/${prepared.id}`)).status, 'partial_delivery');
  await call(
    '/__test/event',
    'POST',
    event('e2', 'one@example.test', 'deferred', '2026-10-14T00:00:00Z'),
  );
  await call(
    '/__test/event',
    'POST',
    event('e3', 'two@example.test', 'delivered', '2026-10-14T00:02:00Z'),
  );
  assert.equal((await call(`/api/messages/${prepared.id}`)).status, 'delivered');
  await call(
    '/__test/event',
    'POST',
    event('e3', 'two@example.test', 'delivered', '2026-10-14T00:02:00Z'),
  );
  assert.equal((await db.prepare('SELECT count(*) count FROM delivery_events').first()).count, 3);
  const uncertain = await call('/api/drafts', 'POST', {
    addressId: boot.addresses[0].id,
    to: ['one@example.test'],
    cc: [],
    bcc: [],
    subject: 'Unknown transport',
    text: 'Uncertain',
    attachments: [],
  });
  const uj = await call(`/api/messages/${uncertain.id}/send`, 'POST', {
    revision: uncertain.revision,
  });
  await db
    .prepare('UPDATE outbox SET due_at=? WHERE id=?')
    .bind('2000-01-01T00:00:00Z', uj.id)
    .run();
  await call(`/__test/send?id=${uj.id}&error=E_INTERNAL_SERVER_ERROR`, 'POST', {});
  assert.equal((await call(`/api/messages/${uncertain.id}`)).status, 'unknown');
  await call('/__test/sweep', 'POST', {});
  assert.equal((await call(`/api/messages/${uncertain.id}`)).status, 'unknown');
  await call(`/api/messages/${uncertain.id}/resolve`, 'POST', { status: 'failed' });
  assert.equal((await call(`/api/messages/${uncertain.id}`)).status, 'failed');
  assert.equal((await call('/api/export')).format, 'postbox-metadata-v1');
  const malformed = await call(
    `/__test/email?from=sender@example.test&to=${encodeURIComponent(boot.addresses[0].email)}&defer=1`,
    'POST',
    'X-Oversize: ' + 'x'.repeat(300000) + '\r\n\r\nBody',
  );
  for (let i = 0; i < 3; i++) await call(`/__test/ingest?id=${malformed.intakeIds[0]}`, 'POST', {});
  assert.equal((await call('/api/bootstrap')).failedIntakes, 1);
  assert.equal(
    (await db.prepare('SELECT status FROM intakes WHERE id=?').bind(malformed.intakeIds[0]).first())
      .status,
    'failed',
  );
  const retained = await mf.dispatchFetch(
    `http://localhost/api/intakes/${malformed.intakeIds[0]}/raw`,
  );
  assert.equal(retained.status, 200);
  assert.ok((await retained.text()).length > 300000);
  await call(`/api/intakes/${malformed.intakeIds[0]}/retry`, 'POST', {});
  assert.equal((await call('/api/bootstrap')).failedIntakes, 0);
  const forged = await mf.dispatchFetch('https://public.example/api/bootstrap', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' },
  });
  assert.equal(forged.status, 403);
  const csrf = await mf.dispatchFetch('http://localhost/api/contacts', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'X-Postbox-Request': '1' },
    body: '{}',
  });
  assert.equal(csrf.status, 403);
  console.log(
    'PASS: workerd/D1/R2 integration — drafts, idempotent sends, undo, queue processing, MIME intake, deduplication, threading, receiving identity, unknown/paused rejection, trash deletion, auth and CSRF.',
  );
} finally {
  await mf.dispose();
}
