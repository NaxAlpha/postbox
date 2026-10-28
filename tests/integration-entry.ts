import { api } from '../src/server/api';
import { deliveryEvent } from '../src/server/delivery';
import app from '../src/index';
import { ingestJob, sendJob, sweep } from '../src/server/mail';
export default {
  ...app,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const u = new URL(request.url);
    if (u.pathname.startsWith('/__test/config/')) {
      const mode = u.searchParams.get('mode') || 'cli';
      const target = new URL(request.url);
      target.pathname = u.pathname.replace('/__test/config', '/api');
      return api(
        new Request(target, request),
        {
          ...env,
          DOMAINS: JSON.stringify([
            {
              name: 'studio.example',
              zoneId: 'a'.repeat(32),
              receiving: true,
              sending: true,
              catchAll: mode === 'catch-all',
            },
          ]),
          ROUTING_TOKEN: mode === 'managed-route' ? 'test-token' : '',
        },
        { email: 'owner@example.test', local: false },
      ).catch((error) => Response.json({ error: error.message }, { status: error.status || 500 }));
    }
    if (u.pathname === '/__test/email') {
      const raw = new Uint8Array(await request.arrayBuffer());
      let rejected = '';
      await app.email(
        {
          from: u.searchParams.get('from') || '',
          to: u.searchParams.get('to') || '',
          headers: new Headers(),
          raw: new Blob([raw]).stream(),
          rawSize: raw.length,
          canBeForwarded: true,
          setReject: (reason: string) => {
            rejected = reason;
          },
          forward: async () => {
            throw new Error('Unsupported');
          },
          reply: async () => {
            throw new Error('Unsupported');
          },
        } as ForwardableEmailMessage,
        env,
      );
      const jobs = await env.DB.prepare("SELECT id FROM intakes WHERE status='pending'").all<{
        id: string;
      }>();
      if (!u.searchParams.has('defer')) for (const j of jobs.results) await ingestJob(env, j.id);
      return Response.json({ rejected, intakeIds: jobs.results.map((j) => j.id) });
    }
    if (u.pathname === '/__test/send') {
      let payload: unknown;
      const code = u.searchParams.get('error');
      const provider = u.searchParams.get('provider');
      const sending =
        provider || code
          ? {
              ...env,
              DEV_MODE: 'off',
              DOMAINS: JSON.stringify([
                { name: 'studio.example', zoneId: 'a'.repeat(32), sending: true },
              ]),
              EMAIL: {
                send: async (input: unknown) => {
                  payload = input;
                  if (code) throw Object.assign(new Error('Provider error'), { code });
                  return { messageId: provider || 'test-provider' };
                },
              },
            }
          : env;
      await sendJob(sending as Env, u.searchParams.get('id') || '');
      return Response.json({ ok: true, payload });
    }
    if (u.pathname === '/__test/ingest') {
      try {
        await ingestJob(env, u.searchParams.get('id') || '');
        return Response.json({ ok: true });
      } catch {
        return Response.json({ ok: false });
      }
    }
    if (u.pathname === '/__test/event') {
      await deliveryEvent(
        {
          ...env,
          DOMAINS: JSON.stringify([
            { name: 'studio.example', zoneId: 'a'.repeat(32), sending: true },
          ]),
        },
        await request.json(),
      );
      return Response.json({ ok: true });
    }
    if (u.pathname === '/__test/sweep') {
      await sweep(env);
      return Response.json({ ok: true });
    }
    return app.fetch(request, env);
  },
};
