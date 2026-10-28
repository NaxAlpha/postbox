import { ZodError } from 'zod';
import { authenticate, checkMutation, HttpError, securityHeaders } from './server/security';
import { api } from './server/api';
import { receive, ingestJob, sendJob, sweep } from './server/mail';
import { deliveryEvent } from './server/delivery';
import { seed } from './server/seed';
import schema from '../migrations/0001.sql?raw';
import migration2 from '../migrations/0002.sql?raw';
import migration3 from '../migrations/0003.sql?raw';
import type { MailJob } from './shared/models';
let localInitialized: Promise<void> | undefined;
async function initLocal(env: Env) {
  if (!localInitialized)
    localInitialized = (async () => {
      await env.DB.exec(schema);
      await env.DB.exec('CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY)');
      for (const [id, sql] of [
        ['0002', migration2],
        ['0003', migration3],
      ])
        if (
          !(await env.DB.prepare('SELECT id FROM schema_migrations WHERE id=?').bind(id).first())
        ) {
          await env.DB.exec(sql);
          await env.DB.prepare('INSERT INTO schema_migrations(id) VALUES(?)').bind(id).run();
        }
      await seed(env);
    })().catch((e) => {
      localInitialized = undefined;
      throw e;
    });
  await localInitialized;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = securityHeaders();
    try {
      const identity = await authenticate(request, env);
      checkMutation(request, identity, env);
      if (identity.local) {
        await initLocal(env);
        headers['Content-Security-Policy'] = headers['Content-Security-Policy']
          .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:* ws://localhost:*");
      }
      const response = new URL(request.url).pathname.startsWith('/api/')
        ? await api(request, env, identity)
        : await env.ASSETS.fetch(request);
      const out = new Response(response.body, response);
      for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
      return out;
    } catch (error) {
      const status =
        error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 500;
      const text =
        error instanceof HttpError
          ? error.message
          : error instanceof ZodError
            ? 'Check the form values'
            : 'Something went wrong. Please try again.';
      if (status === 500)
        console.error(JSON.stringify({ event: 'request_failed', code: 'INTERNAL' }));
      return Response.json({ error: text }, { status, headers });
    }
  },
  async email(message: ForwardableEmailMessage, env: Env) {
    await receive(message, env);
  },
  async queue(
    batch: MessageBatch<
      | MailJob
      | {
          type: string;
          payload: { eventId: string; messageId: string; recipient: string };
          metadata: { eventTimestamp: string };
        }
    >,
    env: Env,
  ) {
    for (const job of batch.messages) {
      try {
        const p = job.body;
        if ('kind' in p) {
          if (p.kind === 'ingest') await ingestJob(env, p.id);
          else if (p.kind === 'send') await sendJob(env, p.id);
          else throw new Error('Unknown job');
        } else {
          await deliveryEvent(env, p);
        }
        job.ack();
      } catch {
        job.retry();
        console.error(JSON.stringify({ event: 'job_failed', id: job.id }));
      }
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<
  Env,
  | MailJob
  | {
      type: string;
      payload: { eventId: string; messageId: string; recipient: string };
      metadata: { eventTimestamp: string };
    }
>;
