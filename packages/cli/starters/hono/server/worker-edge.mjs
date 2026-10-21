import { Hono } from 'hono';
import { createD1Store } from '@mayurajs/storage-d1';
import { createApplication } from './application.mjs';
let ready; let pinned;
function application(env) {
  if (!env.MAYURA_SESSIONS_JSON || env.MAYURA_SESSIONS_JSON.length > 16384) return Promise.reject(new Error('Identity configuration required.'));
  const identity = JSON.stringify([env.MAYURA_PUBLIC_ORIGIN, env.MAYURA_PROJECT_ID, env.MAYURA_SESSIONS_JSON]);
  if (pinned && pinned !== identity) return Promise.reject(new Error('Restart the isolate after changing identity configuration.'));
  pinned = identity;
  return ready ??= createApplication({ store: createD1Store({ database: env.DB }), publicOrigin: env.MAYURA_PUBLIC_ORIGIN, projectId: env.MAYURA_PROJECT_ID, sessions: JSON.parse(env.MAYURA_SESSIONS_JSON) }).catch(error => { ready = undefined; throw error; });
}
const router = new Hono();
router.all('/api/mayura/*', async context => {
  try { return await (await application(context.env)).fetch(context.req.raw); }
  catch { return Response.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, { status: 503 }); }
});
router.get('*', context => context.env.ASSETS.fetch(context.req.raw));
export default { fetch: router.fetch, scheduled(_event, env, context) { context.waitUntil(application(env).then(app => app.runOnce())); } };
