// Live check of @mayurajs/auth-auth0 against a real Auth0 tenant. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-auth0.mjs
// Needs AUTH0_DOMAIN and AUTH0_AUDIENCE (an API's identifier). With AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET of a machine
// application authorized for that API, it gets a real client-credentials token and verifies it.
const root = new URL('../../', import.meta.url);
const { auth0Authenticator } = await import(new URL('extensions/auth-auth0/dist/index.js', root).href);

const { AUTH0_DOMAIN: domain, AUTH0_AUDIENCE: audience, AUTH0_CLIENT_ID: clientId, AUTH0_CLIENT_SECRET: clientSecret } = process.env;
if (!domain || !audience) { console.log('AUTH0_DOMAIN or AUTH0_AUDIENCE is not set; nothing run.'); process.exit(2); }
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
await check('the tenant publishes RS256 keys', async () => {
  const response = await fetch(`https://${domain}/.well-known/jwks.json`);
  const jwks = await response.json();
  if (!response.ok || !jwks.keys?.some(key => key.kty === 'RSA')) throw new Error(`HTTP ${response.status}`);
});
if (clientId && clientSecret) {
  let token;
  await check('a client-credentials token verifies, read as a machine', async () => {
    const response = await fetch(`https://${domain}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience }) });
    if (!response.ok) throw new Error(`token endpoint HTTP ${response.status}`);
    token = (await response.json()).access_token;
    let seen;
    const authenticate = auth0Authenticator({ domain, audience, identity: session => { seen = session; return { principalId: 'auth0/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] }; } });
    if (!await authenticate({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused');
    if (!seen.machine || seen.clientId !== clientId) throw new Error(`machine ${seen.machine}, client ${seen.clientId}`);
    console.log(`  subject ${seen.subject}, ${seen.scopes.length} scopes, ${seen.permissions.length} permissions`);
  });
  await check('the same token for another audience is refused', async () => {
    const other = auth0Authenticator({ domain, audience: 'https://not-this-api.example', identity: () => ({ principalId: 'x/y', projectId: 'p', agentIds: [], capabilities: [] }) });
    if (token && await other({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('accepted');
  });
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
