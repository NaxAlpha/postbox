import { recipientDelivery } from './delivery';
import { z } from 'zod';
import type { Attachment, MailAddress, MailMessage } from '../shared/models';
import { HttpError, jsonBody, boundedBody, sanitizeFilename } from './security';
import { now, address, message, domains, audit } from './storage';
import { composeSchema, saveDraft, submitDraft, cancelSend, purge } from './mail';
const reply = (body: unknown, status = 200) => Response.json(body, { status });
const uuid = z.uuid();
export async function api(
  request: Request,
  env: Env,
  user: { email: string; local: boolean },
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname.replace(/^\/api/, '');
  if (path === '/bootstrap' && request.method === 'GET') {
    const addresses = (
      await env.DB.prepare(
        "SELECT a.*,(SELECT count(*) FROM messages m WHERE m.address_id=a.id AND m.folder='inbox' AND m.is_read=0) unread FROM addresses a ORDER BY created_at",
      ).all<MailAddress>()
    ).results;
    const counts = (
      await env.DB.prepare('SELECT folder,count(*) count FROM messages GROUP BY folder').all<{
        folder: string;
        count: number;
      }>()
    ).results;
    return reply({
      user: user.email,
      local: user.local,
      addresses,
      domains: domains(env).map((d) => ({
        ...d,
        addressCreation: !d.receiving
          ? 'disabled'
          : user.local || d.catchAll
            ? 'catch-all'
            : env.ROUTING_TOKEN
              ? 'managed-route'
              : 'cli',
      })),
      counts: Object.fromEntries(counts.map((c) => [c.folder, c.count])),
      labels: (await env.DB.prepare('SELECT * FROM labels ORDER BY name').all()).results,
      contacts: (await env.DB.prepare('SELECT * FROM contacts ORDER BY name,email').all()).results,
      rules: (await env.DB.prepare('SELECT * FROM rules').all()).results,
      failedIntakes:
        (
          await env.DB.prepare("SELECT count(*) count FROM intakes WHERE status='failed'").first<{
            count: number;
          }>()
        )?.count || 0,
      prefix: env.RESOURCE_PREFIX,
    });
  }
  if (path === '/addresses' && request.method === 'POST') {
    const p = z
      .object({
        email: z.email().max(254),
        name: z.string().min(1).max(96),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default('#8272d5'),
        signature: z.string().max(5000).default(''),
      })
      .strict()
      .parse(await jsonBody(request));
    const email = p.email.toLowerCase();
    if (!/^[\x21-\x7e]+$/.test(email))
      throw new HttpError(400, 'Use an ASCII local part and punycode domain');
    const domain = domains(env).find((d) => d.name === email.split('@')[1]);
    if (!user.local && (!domain || !domain.receiving))
      throw new HttpError(400, 'Configure this receiving domain first');
    const exists = await env.DB.prepare('SELECT id FROM addresses WHERE email=?')
      .bind(email)
      .first();
    if (exists)
      throw new HttpError(409, 'Address is already configured (paused addresses stay reserved)');
    const id = crypto.randomUUID();
    if (!user.local && !domain?.catchAll) {
      if (!env.ROUTING_TOKEN || !domain?.zoneId)
        throw new HttpError(
          409,
          'This domain requires an explicit routing rule. Configure ROUTING_TOKEN or add the address through the installer',
        );
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${domain.zoneId}/email/routing/rules`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.ROUTING_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `${env.RESOURCE_PREFIX}: ${email}`,
            enabled: true,
            matchers: [{ type: 'literal', field: 'to', value: email }],
            actions: [{ type: 'worker', value: [env.WORKER_NAME] }],
          }),
        },
      );
      if (!response.ok) throw new HttpError(502, 'Cloudflare could not create the address route');
      const data = (await response.json()) as { result: { id: string } };
      await env.DB.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
        .bind(
          `route:${id}`,
          JSON.stringify({
            zoneId: domain.zoneId,
            id: data.result.id,
            email,
            body: {
              name: `${env.RESOURCE_PREFIX}: ${email}`,
              enabled: true,
              matchers: [{ type: 'literal', field: 'to', value: email }],
              actions: [{ type: 'worker', value: [env.WORKER_NAME] }],
            },
          }),
        )
        .run();
    }
    await env.DB.prepare(
      'INSERT INTO addresses(id,email,name,color,signature,created_at) VALUES(?,?,?,?,?,?)',
    )
      .bind(id, email, p.name, p.color, p.signature, now())
      .run();
    await audit(env, user.email, 'address.created');
    return reply(await address(env, id), 201);
  }
  const addressMatch = path.match(/^\/addresses\/([^/]+)$/);
  if (addressMatch && request.method === 'PATCH') {
    const id = uuid.parse(addressMatch[1]);
    await address(env, id);
    const p = z
      .object({
        name: z.string().min(1).max(96).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        signature: z.string().max(5000).optional(),
        enabled: z.boolean().optional(),
        send_enabled: z.boolean().optional(),
      })
      .strict()
      .parse(await jsonBody(request));
    for (const [key, value] of Object.entries(p))
      await env.DB.prepare(`UPDATE addresses SET ${key}=? WHERE id=?`)
        .bind(typeof value === 'boolean' ? Number(value) : value, id)
        .run();
    await audit(env, user.email, 'address.updated');
    return reply(await address(env, id));
  }
  if (path === '/messages' && request.method === 'GET') {
    const folder = url.searchParams.get('folder') || 'inbox',
      aid = url.searchParams.get('address'),
      q = (url.searchParams.get('q') || '').slice(0, 200),
      label = url.searchParams.get('label');
    const offset = Math.max(0, Math.min(Number(url.searchParams.get('offset')) || 0, 1000000));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (folder === 'all') where.push("m.folder NOT IN('trash','spam','draft')");
    else if (folder === 'starred') where.push("m.starred=1 AND m.folder NOT IN('trash','spam')");
    else {
      z.enum(['inbox', 'archive', 'sent', 'draft', 'spam', 'trash']).parse(folder);
      where.push('m.folder=?');
      args.push(folder);
    }
    if (aid) {
      where.push('m.address_id=?');
      args.push(uuid.parse(aid));
    }
    if (url.searchParams.get('unread') === '1') where.push('m.is_read=0');
    if (url.searchParams.get('attachments') === '1')
      where.push('EXISTS(SELECT 1 FROM attachments f WHERE f.message_id=m.id)');
    if (label) {
      where.push('EXISTS(SELECT 1 FROM json_each(m.labels_json) WHERE value=?)');
      args.push(label);
    }
    if (q) {
      const tokens = q.match(/[\p{L}\p{N}]+/gu) || [];
      if (tokens.length) {
        where.push('m.rowid IN(SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
        args.push(
          tokens
            .slice(0, 20)
            .map((t) => `"${t}"*`)
            .join(' AND '),
        );
      }
    }
    const filter = where.join(' AND ');
    const results = (
      await env.DB.prepare(
        `SELECT m.*,a.email address_email,a.color address_color,(SELECT count(*) FROM attachments WHERE message_id=m.id) attachment_count FROM messages m JOIN addresses a ON a.id=m.address_id WHERE ${filter} ORDER BY m.received_at DESC,m.id DESC LIMIT 50 OFFSET ?`,
      )
        .bind(...args, offset)
        .all()
    ).results;
    const count = await env.DB.prepare(`SELECT count(*) total FROM messages m WHERE ${filter}`)
      .bind(...args)
      .first<{ total: number }>();
    return reply({ messages: results, total: count?.total || 0, offset });
  }
  const match = path.match(
    /^\/messages\/([^/]+)(?:\/(thread|raw|export|send|undo|resolve|restore))?$/,
  );
  if (match) {
    const id = uuid.parse(match[1]),
      action = match[2];
    const m = await message(env, id);
    if (request.method === 'GET') {
      if (action === 'raw') {
        if (!m.raw_key)
          throw new HttpError(404, 'Original raw message is unavailable for this composed message');
        const raw = await env.MAIL.get(m.raw_key);
        if (!raw) throw new HttpError(404, 'Raw message not found');
        return new Response(raw.body, {
          headers: {
            'Content-Type': 'message/rfc822',
            'Content-Disposition': `attachment; filename="${id}.eml"`,
          },
        });
      }
      let rows = [{ id }],
        hasMore = false;
      if (action === 'thread') {
        const before = url.searchParams.get('before'),
          boundary = before ? await message(env, uuid.parse(before)) : null;
        if (
          boundary &&
          (boundary.address_id !== m.address_id || boundary.thread_id !== m.thread_id)
        )
          throw new HttpError(400, 'Invalid conversation cursor');
        const filter = boundary ? ' AND (received_at<? OR (received_at=? AND id<?))' : '';
        const values = boundary ? [boundary.received_at, boundary.received_at, boundary.id] : [];
        rows = (
          await env.DB.prepare(
            `SELECT id FROM messages WHERE address_id=? AND thread_id=? AND (folder NOT IN('trash','spam','draft') OR id=?)${filter} ORDER BY received_at DESC,id DESC LIMIT 21`,
          )
            .bind(m.address_id, m.thread_id, id, ...values)
            .all<{ id: string }>()
        ).results;
        hasMore = rows.length > 20;
        rows = rows.slice(0, 20);
      }
      const detailed = [];
      for (const row of rows) {
        const item = await message(env, row.id);
        const content = await (
          await env.MAIL.get(item.body_key)
        )?.json<{ text: string; html: string; truncated?: boolean }>();
        const attachments = (
          await env.DB.prepare(
            'SELECT id,message_id,address_id,filename,type,size,content_id,disposition FROM attachments WHERE message_id=?',
          )
            .bind(row.id)
            .all()
        ).results;
        detailed.push({
          ...item,
          ...content,
          attachments,
          delivery: await recipientDelivery(env, item.provider_id),
        });
      }
      if (action === 'export')
        return new Response(JSON.stringify(detailed[0], null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${id}.json"`,
          },
        });
      if (action === 'thread') detailed.reverse();
      return reply(action === 'thread' ? { messages: detailed, hasMore } : detailed[0]);
    }
    if (request.method === 'PATCH') {
      const p = z
        .object({
          is_read: z.boolean().optional(),
          starred: z.boolean().optional(),
          folder: z.enum(['inbox', 'archive', 'spam', 'trash']).optional(),
          labels: z.array(z.string().max(80)).max(20).optional(),
        })
        .strict()
        .parse(await jsonBody(request));
      if (p.folder && m.status === 'queued')
        throw new HttpError(409, 'Undo pending send before moving it');
      const values: { key: string; value: string | number }[] = [];
      if (p.is_read !== undefined) values.push({ key: 'is_read', value: Number(p.is_read) });
      if (p.starred !== undefined) values.push({ key: 'starred', value: Number(p.starred) });
      if (p.folder)
        values.push(
          { key: 'previous_folder', value: m.folder },
          { key: 'folder', value: p.folder },
        );
      if (p.labels) values.push({ key: 'labels_json', value: JSON.stringify(p.labels) });
      if (values.length)
        await env.DB.prepare(
          `UPDATE messages SET ${values.map((v) => `${v.key}=?`).join(',')},updated_at=? WHERE id=?`,
        )
          .bind(...values.map((v) => v.value), now(), id)
          .run();
      return reply({ ok: true });
    }
    if (request.method === 'DELETE') {
      await purge(env, id);
      return reply({ ok: true });
    }
    if (request.method === 'POST' && action === 'restore') {
      if (!['trash', 'spam'].includes(m.folder))
        throw new HttpError(409, 'Message is not in trash or spam');
      const old = (
        await env.DB.prepare('SELECT previous_folder FROM messages WHERE id=?')
          .bind(id)
          .first<{ previous_folder: string }>()
      )?.previous_folder;
      const folder =
        old && ['inbox', 'archive', 'sent', 'draft'].includes(old)
          ? old
          : m.direction === 'outbound'
            ? 'sent'
            : 'inbox';
      await env.DB.prepare('UPDATE messages SET folder=?,updated_at=? WHERE id=?')
        .bind(folder, now(), id)
        .run();
      return reply({ ok: true });
    }
    if (request.method === 'POST' && action === 'resolve') {
      const p = z
        .object({
          status: z.enum(['accepted', 'failed']),
          providerId: z.string().max(200).default(''),
        })
        .strict()
        .parse(await jsonBody(request));
      if (m.status !== 'unknown')
        throw new HttpError(409, 'Only uncertain submissions need resolution');
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE outbox SET status=?,error='' WHERE message_id=? AND status='unknown'",
        ).bind(p.status, id),
        env.DB.prepare(
          "UPDATE messages SET status=?,provider_id=?,error='' WHERE id=? AND status='unknown'",
        ).bind(p.status, p.providerId, id),
      ]);
      await audit(env, user.email, 'send.resolved');
      return reply({ ok: true });
    }
    if (request.method === 'POST' && action === 'send') {
      const input = z
        .object({ revision: z.number().int().min(0).optional() })
        .strict()
        .parse(await jsonBody(request));
      return reply(await submitDraft(env, id, input.revision));
    }
    if (request.method === 'POST' && action === 'undo') {
      await cancelSend(env, id);
      return reply({ ok: true });
    }
  }
  if (path === '/intakes' && request.method === 'GET')
    return reply({
      intakes: (
        await env.DB.prepare(
          "SELECT id,from_address,to_address,status,created_at,error FROM intakes WHERE status='failed' ORDER BY created_at DESC LIMIT 50",
        ).all()
      ).results,
    });
  const intakeMatch = path.match(/^\/intakes\/([^/]+)\/(raw|retry)$/);
  if (intakeMatch) {
    const id = uuid.parse(intakeMatch[1]),
      row = await env.DB.prepare('SELECT * FROM intakes WHERE id=?')
        .bind(id)
        .first<{ raw_key: string; status: string }>();
    if (!row) throw new HttpError(404, 'Intake not found');
    if (request.method === 'GET' && intakeMatch[2] === 'raw') {
      const obj = await env.MAIL.get(row.raw_key);
      if (!obj) throw new HttpError(404, 'Raw message missing');
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'message/rfc822',
          'Content-Disposition': `attachment; filename="${id}.eml"`,
        },
      });
    }
    if (request.method === 'POST' && intakeMatch[2] === 'retry') {
      if (row.status !== 'failed') throw new HttpError(409, 'Only failed intake can be retried');
      await env.DB.prepare(
        "UPDATE intakes SET status='pending',attempts=0,error='' WHERE id=? AND status='failed'",
      )
        .bind(id)
        .run();
      return reply({ ok: true });
    }
  }
  if (path === '/drafts' && request.method === 'POST') {
    const p = composeSchema.parse(await jsonBody(request));
    return reply(await saveDraft(env, p));
  }
  if (path === '/attachments/copy' && request.method === 'POST') {
    const p = z
      .object({ messageId: uuid, addressId: uuid })
      .strict()
      .parse(await jsonBody(request));
    await message(env, p.messageId);
    const a = await address(env, p.addressId);
    if (!a.enabled) throw new HttpError(409, 'Address is paused');
    const originals = (
      await env.DB.prepare('SELECT * FROM attachments WHERE message_id=? LIMIT 32')
        .bind(p.messageId)
        .all<Attachment>()
    ).results;
    const copies = [];
    for (const f of originals) {
      const obj = await env.MAIL.get(f.object_key);
      if (!obj) throw new HttpError(409, 'Original attachment missing');
      const id = crypto.randomUUID(),
        key = `files/${id}`;
      await env.MAIL.put(key, obj.body);
      await env.DB.prepare(
        'INSERT INTO attachments(id,address_id,filename,type,size,object_key,created_at) VALUES(?,?,?,?,?,?,?)',
      )
        .bind(id, a.id, f.filename, f.type, f.size, key, now())
        .run();
      copies.push({ id, filename: f.filename, type: f.type, size: f.size });
    }
    return reply({ attachments: copies });
  }
  if (path === '/attachments' && request.method === 'POST') {
    const aid = uuid.parse(url.searchParams.get('address'));
    const a = await address(env, aid);
    if (!a.enabled) throw new HttpError(409, 'Address is paused');
    const bytes = await boundedBody(request, 3 * 1024 * 1024),
      filename = sanitizeFilename(request.headers.get('X-Filename') || 'attachment'),
      id = crypto.randomUUID(),
      key = `files/${id}`;
    const type = (request.headers.get('Content-Type') || 'application/octet-stream').slice(0, 100);
    await env.MAIL.put(key, bytes);
    await env.DB.prepare(
      'INSERT INTO attachments(id,address_id,filename,type,size,object_key,created_at) VALUES(?,?,?,?,?,?,?)',
    )
      .bind(id, aid, filename, type, bytes.length, key, now())
      .run();
    return reply({ id, filename, type, size: bytes.length }, 201);
  }
  const attachmentMatch = path.match(/^\/attachments\/([^/]+)$/);
  if (attachmentMatch && request.method === 'GET') {
    const id = uuid.parse(attachmentMatch[1]),
      f = await env.DB.prepare('SELECT * FROM attachments WHERE id=?').bind(id).first<Attachment>();
    if (!f) throw new HttpError(404, 'Attachment not found');
    const obj = await env.MAIL.get(f.object_key);
    if (!obj) throw new HttpError(404, 'Attachment not found');
    const inline =
      f.disposition === 'inline' &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type);
    return new Response(obj.body, {
      headers: {
        'Content-Type': inline ? f.type : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      },
    });
  }
  if (path === '/contacts' && request.method === 'POST') {
    const p = z
      .object({ email: z.email(), name: z.string().max(96) })
      .strict()
      .parse(await jsonBody(request));
    await env.DB.prepare(
      'INSERT INTO contacts(email,name) VALUES(?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name',
    )
      .bind(p.email.toLowerCase(), p.name)
      .run();
    return reply({ ok: true });
  }
  if (path === '/contacts' && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM contacts WHERE email=?')
      .bind(z.email().parse(url.searchParams.get('email')))
      .run();
    return reply({ ok: true });
  }
  if (path === '/labels' && request.method === 'POST') {
    const p = z
      .object({ name: z.string().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })
      .strict()
      .parse(await jsonBody(request));
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO labels(id,name,color) VALUES(?,?,?)')
      .bind(id, p.name, p.color)
      .run();
    return reply({ id, ...p }, 201);
  }
  const labelMatch = path.match(/^\/labels\/([^/]+)$/);
  if (labelMatch && request.method === 'DELETE') {
    const id = uuid.parse(labelMatch[1]);
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE messages SET labels_json=(SELECT json_group_array(value) FROM json_each(messages.labels_json) WHERE value!=?) WHERE EXISTS(SELECT 1 FROM json_each(messages.labels_json) WHERE value=?)',
      ).bind(id, id),
      env.DB.prepare("DELETE FROM rules WHERE action='label' AND action_value=?").bind(id),
      env.DB.prepare('DELETE FROM labels WHERE id=?').bind(id),
    ]);
    return reply({ ok: true });
  }
  if (path === '/rules' && request.method === 'POST') {
    const p = z
      .object({
        field: z.enum(['sender', 'recipient', 'subject']),
        operator: z.enum(['contains', 'equals']),
        value: z.string().min(1).max(200),
        action: z.enum(['archive', 'spam', 'label']),
        action_value: z.string().max(80).default(''),
      })
      .strict()
      .parse(await jsonBody(request));
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO rules(id,field,operator,value,action,action_value) VALUES(?,?,?,?,?,?)',
    )
      .bind(id, p.field, p.operator, p.value, p.action, p.action_value)
      .run();
    return reply({ id, ...p }, 201);
  }
  const rule = path.match(/^\/rules\/([^/]+)$/);
  if (rule && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM rules WHERE id=?').bind(uuid.parse(rule[1])).run();
    return reply({ ok: true });
  }
  if (path === '/export' && request.method === 'GET') {
    const encoder = new TextEncoder(),
      addresses = (await env.DB.prepare('SELECT * FROM addresses').all()).results;
    let cursor = '',
      started = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ format: 'postbox-metadata-v1', exportedAt: now(), addresses }).slice(
                0,
                -1,
              ) + ',"messages":[',
            ),
          );
          started = true;
        }
        const page = (
          await env.DB.prepare('SELECT * FROM messages WHERE id>? ORDER BY id LIMIT 100')
            .bind(cursor)
            .all<{ id: string }>()
        ).results;
        for (const record of page) {
          controller.enqueue(encoder.encode((cursor ? ',' : '') + JSON.stringify(record)));
          cursor = record.id;
        }
        if (page.length < 100) {
          controller.enqueue(encoder.encode(']}'));
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="postbox-metadata.json"',
      },
    });
  }
  throw new HttpError(404, 'Endpoint not found');
}
