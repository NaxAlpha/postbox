import type { MailAddress, MailMessage, Domain } from '../shared/models';
import { HttpError } from './security';
export const now = () => new Date().toISOString();
export function domains(env: Env): Domain[] {
  return JSON.parse(env.DOMAINS || '[]');
}
export async function address(env: Env, id: string) {
  const a = await env.DB.prepare('SELECT * FROM addresses WHERE id=?')
    .bind(id)
    .first<MailAddress>();
  if (!a) throw new HttpError(404, 'Address not found');
  return a;
}
export async function message(env: Env, id: string) {
  const m = await env.DB.prepare(
    'SELECT m.*,a.email address_email,a.color address_color FROM messages m JOIN addresses a ON a.id=m.address_id WHERE m.id=?',
  )
    .bind(id)
    .first<MailMessage & { body_key: string; raw_key: string; reply_id: string }>();
  if (!m) throw new HttpError(404, 'Message not found');
  return m;
}
export async function audit(env: Env, actor: string, action: string) {
  await env.DB.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)')
    .bind(`audit:${crypto.randomUUID()}`, JSON.stringify({ actor, action, time: now() }))
    .run();
}
export async function enqueue(env: Env, kind: 'ingest' | 'send', id: string, delaySeconds = 0) {
  try {
    await env.JOBS.send({ kind, id }, { delaySeconds });
  } catch {
    console.warn(JSON.stringify({ event: 'job_persisted_queue_pending', kind, id }));
  }
}
