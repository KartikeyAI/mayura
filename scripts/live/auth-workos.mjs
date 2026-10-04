// Live check of @mayurajs/auth-workos against a real WorkOS environment. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-workos.mjs
// Needs WORKOS_CLIENT_ID; optionally WORKOS_ACCESS_TOKEN (a fresh AuthKit access token from your app), and for Connect
// WORKOS_AUTHKIT_DOMAIN with WORKOS_M2M_CLIENT_ID and WORKOS_M2M_CLIENT_SECRET of a machine-to-machine application.
const root = new URL('../../', import.meta.url);
const { workosAuthenticator } = await import(new URL('extensions/auth-workos/dist/index.js', root).href);

const { WORKOS_CLIENT_ID: clientId, WORKOS_ACCESS_TOKEN: token, WORKOS_AUTHKIT_DOMAIN: domain, WORKOS_M2M_CLIENT_ID: m2mId, WORKOS_M2M_CLIENT_SECRET: m2mSecret } = process.env;
if (!clientId) { console.log('WORKOS_CLIENT_ID is not set; nothing run.'); process.exit(2); }
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
const grant = { principalId: 'workos/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] };
await check('the client\'s JWKS publishes RSA keys', async () => {
  const response = await fetch(`https://api.workos.com/sso/jwks/${clientId}`);
  const jwks = await response.json();
  if (!response.ok || !jwks.keys?.some(key => key.kty === 'RSA')) throw new Error(`HTTP ${response.status}`);
});
if (token) {
  await check('a real AuthKit access token verifies', async () => {
    let seen;
    const authenticate = workosAuthenticator({ clientId, identity: session => { seen = session; return grant; } });
    if (!await authenticate({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused (expired? or a custom auth domain: set issuer)');
    console.log(`  user ${seen.subject}, org ${seen.orgId ?? 'none'}, role ${seen.role ?? 'none'}, ${seen.permissions.length} permissions`);
  });
}
if (domain && m2mId && m2mSecret) {
  await check('a real machine-to-machine token verifies, only with allowMachines', async () => {
    const response = await fetch(`${domain}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: m2mId, client_secret: m2mSecret }) });
    if (!response.ok) throw new Error(`token endpoint HTTP ${response.status}`);
    const { access_token: machineToken } = await response.json();
    const strict = workosAuthenticator({ clientId, connect: { domain }, identity: () => grant });
    if (await strict({ token: machineToken, signal: AbortSignal.timeout(10_000) })) throw new Error('accepted without allowMachines');
    let seen;
    const machines = workosAuthenticator({ clientId, connect: { domain }, allowMachines: true, identity: session => { seen = session; return grant; } });
    if (!await machines({ token: machineToken, signal: AbortSignal.timeout(10_000) })) throw new Error('refused with allowMachines');
    console.log(`  machine ${seen.subject}, org ${seen.orgId ?? 'none'}, scopes ${seen.scopes.join(' ') || 'none'}`);
  });
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
