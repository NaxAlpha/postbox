import { reconcileDelivery } from './delivery';
import PostalMime from 'postal-mime';
import { z } from 'zod';
import type { Attachment, Compose, MailAddress, MailMessage } from '../shared/models';
import { HttpError, safeHtml, emailHtml, sanitizeFilename } from './security';
import { now, address, message, domains, enqueue } from './storage';
export const composeSchema = z
  .object({
    id: z.uuid().optional(),
    revision: z.number().int().min(0).optional(),
    addressId: z.uuid(),
    to: z.array(z.string().max(254)).max(50),
    cc: z.array(z.string().max(254)).max(50),
    bcc: z.array(z.string().max(254)).max(50),
    subject: z.string().max(998),
    text: z.string().max(200000),
    html: z.string().max(300000).optional(),
    attachments: z.array(z.uuid()).max(32),
    replyToMessageId: z.uuid().optional(),
    forwardMessageId: z.uuid().optional(),
  })
  .strict();
export async function saveDraft(env: Env, input: Compose) {
  const a = await address(env, input.addressId);
  if (!a.enabled) throw new HttpError(409, 'Address is paused');
  const id = input.id || crypto.randomUUID(),
    revision = input.revision || 0;
  const old = await env.DB.prepare('SELECT folder,revision,body_key FROM messages WHERE id=?')
    .bind(id)
    .first<{ folder: string; revision: number; body_key: string }>();
  if (old && (old.folder !== 'draft' || old.revision !== revision))
    throw new HttpError(409, 'Draft changed elsewhere. Close and reopen it before editing.');
  const files: Attachment[] = [];
  for (const key of input.attachments) {
    const f = await env.DB.prepare(
      'SELECT * FROM attachments WHERE id=? AND address_id=? AND (message_id IS NULL OR message_id=?)',
    )
      .bind(key, a.id, id)
      .first<Attachment>();
    if (!f) throw new HttpError(400, 'Attachment does not belong to this draft');
    files.push(f);
  }
  const date = now();
  let thread = id;
  if (input.replyToMessageId) {
    const orig = await message(env, input.replyToMessageId);
    if (orig.address_id !== a.id)
      throw new HttpError(400, 'Reply must use the original receiving address');
    thread = orig.thread_id;
  }
  if (input.forwardMessageId) await message(env, input.forwardMessageId);
  const bodyKey = `bodies/${id}/${crypto.randomUUID()}.json`;
  await env.MAIL.put(bodyKey, JSON.stringify({ text: input.text, html: emailHtml(input.text) }));
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages(id,address_id,thread_id,folder,direction,subject,from_address,from_name,to_json,cc_json,bcc_json,snippet,received_at,is_read,status,body_key,search_text,reply_id,forward_id,revision,updated_at) VALUES(?,?,?,'draft','outbound',?,?,?,?,?,?,?,?,1,'draft',?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET address_id=excluded.address_id,thread_id=excluded.thread_id,subject=excluded.subject,from_address=excluded.from_address,from_name=excluded.from_name,to_json=excluded.to_json,cc_json=excluded.cc_json,bcc_json=excluded.bcc_json,snippet=excluded.snippet,body_key=excluded.body_key,search_text=excluded.search_text,reply_id=excluded.reply_id,forward_id=excluded.forward_id,revision=messages.revision+1,updated_at=excluded.updated_at WHERE messages.folder='draft' AND messages.revision=?`,
    ).bind(
      id,
      a.id,
      thread,
      input.subject,
      a.email,
      a.name,
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      JSON.stringify(input.bcc),
      input.text.slice(0, 180),
      date,
      bodyKey,
      input.text.slice(0, 200000),
      input.replyToMessageId || null,
      input.forwardMessageId || null,
      date,
      revision,
    ),
    env.DB.prepare(
      'UPDATE attachments SET message_id=NULL WHERE message_id=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND body_key=?)',
    ).bind(id, id, bodyKey),
    ...files.map((f) =>
      env.DB.prepare(
        'UPDATE attachments SET message_id=? WHERE id=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND body_key=?)',
      ).bind(id, f.id, id, bodyKey),
    ),
  ]);
  if (!result[0].meta.changes) {
    await env.MAIL.delete(bodyKey);
    throw new HttpError(409, 'Draft changed elsewhere. Close and reopen it before editing.');
  }
  // Immutable object keys prevent a racing save from changing a submission snapshot.
  if (old?.body_key) await env.MAIL.delete(old.body_key);
  return { id, revision: revision + 1 };
}
export async function submitDraft(env: Env, id: string, expectedRevision?: number) {
  const old = await env.DB.prepare('SELECT id,status FROM outbox WHERE message_id=?')
    .bind(id)
    .first<{ id: string; status: string }>();
  if (old) return old;
  const m = await message(env, id);
  if (expectedRevision === undefined)
    throw new HttpError(400, 'The reviewed draft revision is required');
  if (m.folder !== 'draft') throw new HttpError(409, 'Only drafts can be submitted');
  if (expectedRevision !== undefined && m.revision !== expectedRevision)
    throw new HttpError(409, 'Draft changed after review; review it again before sending');
  const a = await address(env, m.address_id);
  if (!a.enabled || !a.send_enabled)
    throw new HttpError(403, 'Sending is disabled for this address');
  if (
    env.DEV_MODE !== 'local' &&
    !domains(env).some((d) => d.name === a.email.split('@')[1] && d.sending)
  )
    throw new HttpError(409, 'Sending domain is not configured');
  const to = JSON.parse(m.to_json) as string[],
    cc = JSON.parse(m.cc_json) as string[],
    bcc = JSON.parse(m.bcc_json) as string[];
  z.array(z.email()).parse([...to, ...cc, ...bcc]);
  if (!to.length || to.length + cc.length + bcc.length > 50)
    throw new HttpError(400, 'Choose recipients (maximum 50 combined)');
  const body = await (await env.MAIL.get(m.body_key))?.json<{ text: string; html: string }>();
  if (!body) throw new HttpError(409, 'Draft body is missing');
  const files = (
    await env.DB.prepare('SELECT * FROM attachments WHERE message_id=?').bind(id).all<Attachment>()
  ).results;
  const estimated =
    new TextEncoder().encode(body.text + body.html).length +
    files.reduce((sum, f) => sum + Math.ceil(f.size / 3) * 4 + 2048, 0) +
    8192;
  if (estimated > 5 * 1024 * 1024)
    throw new HttpError(413, 'Encoded message exceeds the 5 MiB sending limit');
  const bucket = `${new Date().toISOString().slice(0, 13)}:send`;
  const quota = await env.DB.prepare(
    'INSERT INTO send_quota(bucket,count) VALUES(?,1) ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count<? RETURNING count',
  )
    .bind(bucket, Number(env.SEND_LIMIT) || 100)
    .first();
  if (!quota) throw new HttpError(429, 'Hourly sending limit reached');
  const jobId = crypto.randomUUID(),
    payloadKey = `outbox/${jobId}.json`,
    date = now(),
    due = new Date(Date.now() + 10000).toISOString();
  await env.MAIL.put(
    payloadKey,
    JSON.stringify({
      messageId: id,
      addressId: a.id,
      to,
      cc,
      bcc,
      subject: m.subject,
      text: body.text,
      html: body.html,
      attachments: files.map((f) => f.id),
      replyId: m.reply_id,
    }),
  );
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET folder='sent',status='queued',received_at=?,updated_at=? WHERE id=? AND folder='draft' AND revision=?",
    ).bind(date, date, id, m.revision),
    env.DB.prepare(
      "INSERT OR IGNORE INTO outbox(id,message_id,due_at,payload_key,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND status='queued' AND revision=?)",
    ).bind(jobId, id, due, payloadKey, date, id, m.revision),
  ]);
  if (!result[1].meta.changes) {
    await env.MAIL.delete(payloadKey);
    const existing = await env.DB.prepare('SELECT id,status FROM outbox WHERE message_id=?')
      .bind(id)
      .first<{ id: string; status: string }>();
    if (existing) return existing;
    throw new HttpError(409, 'Draft was changed during submission');
  }
  await enqueue(env, 'send', jobId, 10);
  return { id: jobId, status: 'queued' };
}
export async function cancelSend(env: Env, messageId: string) {
  const result = await env.DB.prepare(
    `UPDATE outbox SET status='cancelled' WHERE message_id=? AND status='queued' AND due_at>? RETURNING id,payload_key`,
  )
    .bind(messageId, now())
    .first<{ id: string; payload_key: string }>();
  if (!result) throw new HttpError(409, 'Message has already been submitted');
  await env.DB.prepare(`UPDATE messages SET folder='draft',status='draft' WHERE id=?`)
    .bind(messageId)
    .run();
  await env.DB.prepare('DELETE FROM outbox WHERE id=?').bind(result.id).run();
  await env.MAIL.delete(result.payload_key);
}
export async function sendJob(env: Env, id: string) {
  const claim = await env.DB.prepare(
    `UPDATE outbox SET status='processing',claimed_at=?,attempts=attempts+1 WHERE id=? AND status='queued' AND due_at<=? RETURNING *`,
  )
    .bind(now(), id, now())
    .first<{ message_id: string; payload_key: string; attempts: number }>();
  if (!claim) return;
  const p = await (
    await env.MAIL.get(claim.payload_key)
  )?.json<{
    messageId: string;
    addressId: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    text: string;
    html: string;
    attachments: string[];
    replyId: string;
  }>();
  let submitting = false;
  try {
    if (!p) throw new Error('Submission payload missing');
    const a = await address(env, p.addressId);
    if (!a.enabled || !a.send_enabled) throw new Error('Address is paused');
    if (
      env.DEV_MODE !== 'local' &&
      !domains(env).some((d) => d.name === a.email.split('@')[1] && d.sending)
    )
      throw new Error('Sending domain disabled');
    const attachments = [];
    for (const fileId of p.attachments) {
      const f = await env.DB.prepare(
        'SELECT * FROM attachments WHERE id=? AND message_id=? AND address_id=?',
      )
        .bind(fileId, p.messageId, p.addressId)
        .first<Attachment>();
      if (!f) throw new Error('Attachment missing');
      const obj = await env.MAIL.get(f.object_key);
      if (!obj) throw new Error('Attachment missing');
      attachments.push({
        filename: f.filename,
        type: f.type,
        content: await obj.arrayBuffer(),
        disposition: 'attachment' as const,
      });
    }
    const headers: Record<string, string> = { 'X-Postbox-Submission': id };
    if (p.replyId) {
      const original = await message(env, p.replyId);
      if (/^<[^<>\s]{1,2000}>$/.test(original.rfc_id)) {
        headers['In-Reply-To'] = original.rfc_id;
        headers['References'] = original.rfc_id;
      }
    }
    submitting = true;
    const result =
      env.DEV_MODE === 'local'
        ? { messageId: `local-${crypto.randomUUID()}` }
        : await env.EMAIL.send({
            from: { email: a.email, name: a.name },
            to: p.to,
            cc: p.cc,
            bcc: p.bcc,
            subject: p.subject,
            text: p.text,
            html: p.html,
            headers,
            attachments,
          });
    await env.DB.batch([
      env.DB.prepare("UPDATE outbox SET status='accepted' WHERE id=?").bind(id),
      env.DB.prepare("UPDATE messages SET status=?,provider_id=?,error='' WHERE id=?").bind(
        env.DEV_MODE === 'local' ? 'simulated' : 'accepted',
        result.messageId,
        p.messageId,
      ),
    ]);
    await reconcileDelivery(env, result.messageId);
  } catch (error) {
    const code = (error as { code?: string }).code || '';
    const retryable = ['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED'].includes(code);
    const knownRejected = [
      'E_VALIDATION_ERROR',
      'E_SENDER_NOT_VERIFIED',
      'E_RECIPIENT_NOT_ALLOWED',
      'E_RECIPIENT_SUPPRESSED',
      'E_CONTENT_TOO_LARGE',
      'E_SENDER_DOMAIN_NOT_AVAILABLE',
      'E_FIELD_MISSING',
      'E_TOO_MANY_RECIPIENTS',
      'E_HEADER_NOT_ALLOWED',
      'E_HEADER_USE_API_FIELD',
      'E_HEADER_VALUE_INVALID',
      'E_TOO_MANY_ATTACHMENTS',
      'E_DELIVERY_FAILED',
      'E_HEADER_VALUE_TOO_LONG',
      'E_HEADER_NAME_INVALID',
      'E_HEADERS_TOO_LARGE',
      'E_HEADERS_TOO_MANY',
    ].includes(code);
    const status =
      retryable && claim.attempts < 5
        ? 'queued'
        : submitting && !knownRejected && !retryable
          ? 'unknown'
          : 'failed';
    const reason =
      status === 'unknown'
        ? 'Delivery result unknown; inspect provider logs before retrying'
        : knownRejected
          ? code
          : retryable
            ? 'Sending quota reached'
            : submitting
              ? 'Submission failed'
              : 'Message could not be prepared';
    await env.DB.batch([
      env.DB.prepare('UPDATE outbox SET status=?,due_at=?,error=? WHERE id=?').bind(
        status,
        new Date(Date.now() + 60000).toISOString(),
        reason,
        id,
      ),
      env.DB.prepare('UPDATE messages SET status=?,error=? WHERE id=?').bind(
        status,
        reason,
        claim.message_id,
      ),
    ]);
    if (status === 'queued') await enqueue(env, 'send', id, 60);
  }
}
export async function receive(message: ForwardableEmailMessage, env: Env) {
  const a = await env.DB.prepare('SELECT * FROM addresses WHERE email=? AND enabled=1')
    .bind(message.to.toLowerCase())
    .first<MailAddress>();
  if (!a) {
    message.setReject('Recipient address is not configured');
    return;
  }
  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject('Message is too large');
    return;
  }
  const id = crypto.randomUUID(),
    key = `raw/${id}.eml`,
    date = now();
  const fixed = new FixedLengthStream(message.rawSize);
  await Promise.all([
    message.raw.pipeTo(fixed.writable),
    env.MAIL.put(key, fixed.readable, {
      customMetadata: { addressId: a.id, from: message.from, to: message.to, createdAt: date },
    }),
  ]);
  await env.DB.prepare(
    'INSERT INTO intakes(id,address_id,raw_key,from_address,to_address,created_at) VALUES(?,?,?,?,?,?)',
  )
    .bind(id, a.id, key, message.from, message.to, date)
    .run();
  await enqueue(env, 'ingest', id);
}
export async function ingestJob(env: Env, id: string) {
  const intake = await env.DB.prepare(
    "UPDATE intakes SET status='processing',claimed_at=?,attempts=attempts+1 WHERE id=? AND status='pending' AND attempts<3 RETURNING *",
  )
    .bind(now(), id)
    .first<{
      address_id: string;
      raw_key: string;
      from_address: string;
      to_address: string;
      created_at: string;
      attempts: number;
    }>();
  if (!intake) return;
  try {
    const obj = await env.MAIL.get(intake.raw_key);
    if (!obj) throw new Error('Raw mail missing');
    const raw = await obj.arrayBuffer();
    if (raw.byteLength > 25 * 1024 * 1024) throw new Error('Raw mail too large');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const deliveryKey = `${intake.address_id}:${digest}`;
    if (
      await env.DB.prepare('SELECT id FROM messages WHERE delivery_key=?').bind(deliveryKey).first()
    ) {
      await env.MAIL.delete(intake.raw_key);
      await env.DB.prepare('DELETE FROM intakes WHERE id=?').bind(id).run();
      return;
    }
    const parsed = await PostalMime.parse(raw, {
        maxNestingDepth: 32,
        maxHeadersSize: 256 * 1024,
        maxPartCount: 256,
        maxRfc822NestingDepth: 5,
      }),
      mid = crypto.randomUUID();
    const references = [
      parsed.inReplyTo,
      ...(parsed.references?.match(/<[^>]+>/g) || []).reverse(),
    ].filter((x): x is string => !!x);
    let parent: { thread_id: string } | null = null;
    for (const ref of references.slice(0, 20)) {
      parent = await env.DB.prepare(
        'SELECT thread_id FROM messages WHERE address_id=? AND rfc_id=? LIMIT 1',
      )
        .bind(intake.address_id, ref)
        .first<{ thread_id: string }>();
      if (parent) break;
    }
    const contents = parsed.attachments.map((f) => {
      if (typeof f.content === 'string') throw new Error('Unexpected attachment encoding');
      return f.content;
    });
    const files: Attachment[] = parsed.attachments.map((f, i) => ({
      id: crypto.randomUUID(),
      message_id: mid,
      address_id: intake.address_id,
      filename: sanitizeFilename(f.filename || 'attachment'),
      type: f.mimeType,
      size: contents[i].byteLength,
      object_key: '',
      content_id: f.contentId || '',
      disposition: f.disposition || 'attachment',
    }));
    const cid = Object.fromEntries(
      files.filter((f) => f.content_id).map((f) => [f.content_id.replace(/^<|>$/g, ''), f.id]),
    );
    const text = (parsed.text || '').slice(0, 500000),
      html = safeHtml(parsed.html?.slice(0, 1000000) || emailHtml(text), cid),
      truncated = (parsed.text?.length || 0) > 500000 || (parsed.html?.length || 0) > 1000000;
    const bodyKey = `bodies/${mid}.json`;
    await env.MAIL.put(bodyKey, JSON.stringify({ text, html, truncated }));
    for (let i = 0; i < files.length; i++) {
      files[i].object_key = `files/${files[i].id}`;
      await env.MAIL.put(files[i].object_key, contents[i]);
    }
    let folder = 'inbox';
    const labels: string[] = [];
    const rules = (
      await env.DB.prepare('SELECT * FROM rules WHERE enabled=1').all<{
        field: string;
        operator: string;
        value: string;
        action: string;
        action_value: string;
      }>()
    ).results;
    for (const r of rules) {
      const val =
        r.field === 'sender'
          ? parsed.from?.address || intake.from_address
          : r.field === 'recipient'
            ? intake.to_address
            : parsed.subject || '';
      const matches =
        r.operator === 'equals'
          ? val.toLowerCase() === r.value.toLowerCase()
          : val.toLowerCase().includes(r.value.toLowerCase());
      if (matches) {
        if (['archive', 'spam'].includes(r.action)) folder = r.action;
        if (r.action === 'label') labels.push(r.action_value);
      }
    }
    const date = intake.created_at,
      from = parsed.from?.address || intake.from_address;
    const inserted = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO messages(id,address_id,thread_id,folder,direction,subject,from_address,from_name,to_json,cc_json,reply_to_json,snippet,received_at,labels_json,size,rfc_id,body_key,raw_key,search_text,delivery_key,updated_at) VALUES(?,?,?,?,'inbound',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        mid,
        intake.address_id,
        parent?.thread_id || mid,
        folder,
        parsed.subject || '(No subject)',
        from,
        parsed.from?.name || '',
        JSON.stringify((parsed.to || []).map((x) => x.address)),
        JSON.stringify((parsed.cc || []).map((x) => x.address)),
        JSON.stringify(
          (parsed.replyTo || [])
            .map((x) => x.address)
            .filter((x) => z.email().safeParse(x).success),
        ),
        text.slice(0, 180),
        date,
        JSON.stringify(labels),
        raw.byteLength,
        parsed.messageId || '',
        bodyKey,
        intake.raw_key,
        text.slice(0, 200000),
        deliveryKey,
        date,
      ),
      ...files.map((f) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO attachments(id,message_id,address_id,filename,type,size,object_key,content_id,disposition,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=?)',
        ).bind(
          f.id,
          mid,
          f.address_id,
          f.filename,
          f.type,
          f.size,
          f.object_key,
          f.content_id,
          f.disposition,
          date,
          mid,
        ),
      ),
      env.DB.prepare("UPDATE intakes SET status='done' WHERE id=?").bind(id),
    ]);
    if (!inserted[0].meta.changes) {
      await env.MAIL.delete([bodyKey, intake.raw_key, ...files.map((f) => f.object_key)]);
      await env.DB.prepare('DELETE FROM intakes WHERE id=?').bind(id).run();
    }
  } catch (error) {
    await env.DB.prepare('UPDATE intakes SET status=?,error=? WHERE id=?')
      .bind(
        intake.attempts >= 3 ? 'failed' : 'pending',
        'Stored mail could not be parsed or indexed. Download the original or retry after checking storage and MIME format.',
        id,
      )
      .run();
    throw error;
  }
}
export async function sweep(env: Env) {
  // Never automatically resubmit a job whose provider call may already have succeeded.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET status='unknown',error='Submission interrupted; inspect provider logs before retrying' WHERE id IN(SELECT message_id FROM outbox WHERE status='processing' AND claimed_at<?)",
    ).bind(new Date(Date.now() - 5 * 60000).toISOString()),
    env.DB.prepare(
      "UPDATE outbox SET status='unknown' WHERE status='processing' AND claimed_at<?",
    ).bind(new Date(Date.now() - 5 * 60000).toISOString()),
  ]);
  await env.DB.prepare(
    "UPDATE intakes SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error='Intake processing was interrupted; original mail is retained' WHERE status='processing' AND claimed_at<?",
  )
    .bind(new Date(Date.now() - 5 * 60000).toISOString())
    .run();
  for (const job of (
    await env.DB.prepare("SELECT id FROM outbox WHERE status='queued' AND due_at<=? LIMIT 100")
      .bind(now())
      .all<{ id: string }>()
  ).results)
    await enqueue(env, 'send', job.id);
  for (const job of (
    await env.DB.prepare("SELECT id FROM intakes WHERE status='pending' LIMIT 100").all<{
      id: string;
    }>()
  ).results)
    await enqueue(env, 'ingest', job.id);
  // Recover streamed raw mail when intake record creation was interrupted. Cursor avoids rescanning only page one.
  const cursor = (
    await env.DB.prepare("SELECT value FROM settings WHERE key='raw-recovery-cursor'").first<{
      value: string;
    }>()
  )?.value;
  const page = await env.MAIL.list({
    prefix: 'raw/',
    limit: 100,
    include: ['customMetadata'],
    ...(cursor ? { cursor } : {}),
  });
  for (const obj of page.objects) {
    const meta = obj.customMetadata;
    if (!meta?.addressId) continue;
    const id = obj.key.slice(4, -4);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO intakes(id,address_id,raw_key,from_address,to_address,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM addresses WHERE id=?)',
    )
      .bind(
        id,
        meta.addressId,
        obj.key,
        meta.from || '',
        meta.to || '',
        meta.createdAt || now(),
        meta.addressId,
      )
      .run();
  }
  await env.DB.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('raw-recovery-cursor',?)")
    .bind(page.truncated ? page.cursor : '')
    .run();
  const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  const detached = (
    await env.DB.prepare(
      'SELECT id,object_key FROM attachments WHERE message_id IS NULL AND created_at<? LIMIT 50',
    )
      .bind(cutoff)
      .all<{ id: string; object_key: string }>()
  ).results;
  for (const f of detached) {
    await env.MAIL.delete(f.object_key);
    await env.DB.prepare('DELETE FROM attachments WHERE id=? AND message_id IS NULL')
      .bind(f.id)
      .run();
  }
  for (const prefix of ['bodies/', 'files/']) {
    const key = `gc:${prefix}`,
      cursor = (
        await env.DB.prepare('SELECT value FROM settings WHERE key=?')
          .bind(key)
          .first<{ value: string }>()
      )?.value;
    const page = await env.MAIL.list({ prefix, limit: 50, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) {
      if (obj.uploaded.toISOString() >= cutoff) continue;
      const used =
        prefix === 'bodies/'
          ? await env.DB.prepare('SELECT id FROM messages WHERE body_key=? LIMIT 1')
              .bind(obj.key)
              .first()
          : await env.DB.prepare('SELECT id FROM attachments WHERE object_key=? LIMIT 1')
              .bind(obj.key)
              .first();
      if (!used) await env.MAIL.delete(obj.key);
    }
    await env.DB.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
      .bind(key, page.truncated ? page.cursor : '')
      .run();
  }
  await env.DB.prepare('DELETE FROM send_quota WHERE bucket<?')
    .bind(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 13))
    .run();
  for (const folder of ['trash', 'spam']) {
    const days = Number(folder === 'trash' ? env.TRASH_DAYS : env.SPAM_DAYS) || 30;
    const expired = (
      await env.DB.prepare(
        "SELECT id FROM messages WHERE folder=? AND updated_at<? AND NOT EXISTS(SELECT 1 FROM outbox WHERE message_id=messages.id AND status IN('queued','processing','unknown')) LIMIT 50",
      )
        .bind(folder, new Date(Date.now() - days * 86400000).toISOString())
        .all<{ id: string }>()
    ).results;
    for (const m of expired) await purge(env, m.id);
  }
}
export async function purge(env: Env, id: string) {
  const m = await message(env, id);
  if (m.folder !== 'trash' && m.folder !== 'spam')
    throw new HttpError(409, 'Move message to trash before deleting permanently');
  if (
    await env.DB.prepare(
      "SELECT id FROM outbox WHERE message_id=? AND status IN('queued','processing','unknown')",
    )
      .bind(id)
      .first()
  )
    throw new HttpError(409, 'Resolve pending send before deleting');
  const files = (
    await env.DB.prepare('SELECT object_key FROM attachments WHERE message_id=?')
      .bind(id)
      .all<{ object_key: string }>()
  ).results;
  const keys = [m.body_key, m.raw_key, ...files.map((f) => f.object_key)].filter(Boolean);
  if (keys.length) await env.MAIL.delete(keys);
  if (m.raw_key) await env.DB.prepare('DELETE FROM intakes WHERE raw_key=?').bind(m.raw_key).run();
  const outbox = await env.DB.prepare('SELECT payload_key FROM outbox WHERE message_id=?')
    .bind(id)
    .first<{ payload_key: string }>();
  if (outbox) await env.MAIL.delete(outbox.payload_key);
  await env.DB.prepare('DELETE FROM messages WHERE id=?').bind(id).run();
}
