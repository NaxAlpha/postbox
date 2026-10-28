import { z } from 'zod';
import { domains } from './storage';
const states = ['delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'] as const;
const eventSchema = z.object({
  type: z.string(),
  source: z.object({ type: z.literal('email.sending'), zoneId: z.string(), domain: z.string() }),
  payload: z.object({
    eventId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200),
    recipient: z.email(),
  }),
  metadata: z.object({ eventTimestamp: z.iso.datetime() }),
});
const terminal = new Set(['delivered', 'bounced', 'failed', 'rejected', 'complained']);
export async function recipientDelivery(env: Env, providerId: string) {
  if (!providerId) return [];
  const events = (
    await env.DB.prepare(
      'SELECT recipient,status,created_at FROM delivery_events WHERE provider_id=? ORDER BY created_at,id',
    )
      .bind(providerId)
      .all<{ recipient: string; status: string; created_at: string }>()
  ).results;
  const recipients = new Map<string, { recipient: string; status: string; created_at: string }>();
  for (const event of events) {
    const old = recipients.get(event.recipient);
    if (!old || !terminal.has(old.status) || event.status === 'complained')
      recipients.set(event.recipient, event);
  }
  return [...recipients.values()];
}
export async function reconcileDelivery(env: Env, providerId: string) {
  const m = await env.DB.prepare(
    'SELECT id,to_json,cc_json,bcc_json FROM messages WHERE provider_id=?',
  )
    .bind(providerId)
    .first<{ id: string; to_json: string; cc_json: string; bcc_json: string }>();
  if (!m) return;
  const expected = new Set<string>(
    [...JSON.parse(m.to_json), ...JSON.parse(m.cc_json), ...JSON.parse(m.bcc_json)].map((x) =>
      x.toLowerCase(),
    ),
  );
  const events = (await recipientDelivery(env, providerId)).filter((e) =>
    expected.has(e.recipient),
  );
  if (!events.length) return;
  const issue = events.find((e) =>
    ['complained', 'bounced', 'failed', 'rejected'].includes(e.status),
  );
  const status = issue
    ? expected.size > 1
      ? 'partial_failure'
      : issue.status
    : events.every((e) => e.status === 'delivered') && events.length === expected.size
      ? 'delivered'
      : events.some((e) => e.status === 'deferred')
        ? 'deferred'
        : 'partial_delivery';
  await env.DB.prepare('UPDATE messages SET status=? WHERE id=?').bind(status, m.id).run();
}
export async function deliveryEvent(env: Env, input: unknown) {
  const event = eventSchema.parse(input),
    status = event.type.replace('cf.email.sending.message.', '');
  if (
    !states.includes(status as (typeof states)[number]) ||
    !event.type.startsWith('cf.email.sending.message.')
  )
    throw new Error('Unexpected event type');
  if (
    !domains(env).some(
      (d) => d.sending && d.name === event.source.domain && d.zoneId === event.source.zoneId,
    )
  )
    throw new Error('Event source is not a configured sending domain');
  await env.DB.prepare(
    'INSERT OR IGNORE INTO delivery_events(id,created_at,provider_id,recipient,status) VALUES(?,?,?,?,?)',
  )
    .bind(
      event.payload.eventId,
      event.metadata.eventTimestamp,
      event.payload.messageId,
      event.payload.recipient.toLowerCase(),
      status,
    )
    .run();
  // Reconciliation also runs after send acceptance, so an early event is not lost.
  await reconcileDelivery(env, event.payload.messageId);
}
