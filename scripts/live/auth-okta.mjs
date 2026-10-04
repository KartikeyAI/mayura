// Live check of @mayurajs/auth-okta against a real Okta org. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-okta.mjs
// Needs OKTA_DOMAIN (and OKTA_AUTH_SERVER, `default` if unset, and OKTA_AUDIENCE, `api://default` if unset). With
// OKTA_CLIENT_ID, OKTA_CLIENT_SECRET and OKTA_SCOPE of an API services app allowed a custom scope on that server, it gets a
// real client-credentials token and checks it is refused without allowMachines and verifies with it.
const root = new URL('../../', import.meta.url);
const { oktaAuthenticator } = await import(new URL('extensions/auth-okta/dist/index.js', root).href);

const { OKTA_DOMAIN: domain, OKTA_AUTH_SERVER: server = 'default', OKTA_AUDIENCE: audience = 'api://default', OKTA_CLIENT_ID: clientId, OKTA_CLIENT_SECRET: secret, OKTA_SCOPE: scope } = process.env;
if (!domain) { console.log('OKTA_DOMAIN is not set; nothing run.'); process.exit(2); }
const issuer = `https://${domain}/oauth2/${server}`;
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
await check('the authorization server names itself the issuer and its keys at /v1/keys', async () => {
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
  const metadata = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (metadata.issuer !== issuer || metadata.jwks_uri !== `${issuer}/v1/keys`) throw new Error(`issuer ${metadata.issuer}, jwks_uri ${metadata.jwks_uri}`);
  const jwks = await (await fetch(metadata.jwks_uri)).json();
  if (!jwks.keys?.some(key => key.kty === 'RSA')) throw new Error('no RSA keys');
});
if (clientId && secret && scope) {
  await check('a client-credentials token is refused without allowMachines and verifies with it', async () => {
    const response = await fetch(`${issuer}/v1/token`, { method: 'POST', headers: { authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope }) });
    if (!response.ok) throw new Error(`token HTTP ${response.status}`);
    const { access_token: token } = await response.json();
    let seen;
    const options = { domain, authorizationServer: server, audience, identity: session => { seen = session; return { principalId: 'okta/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] }; } };
    if (await oktaAuthenticator(options)({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('accepted a machine token without allowMachines');
    if (!await oktaAuthenticator({ ...options, allowMachines: true })({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused');
    if (!seen.machine || seen.clientId !== clientId) throw new Error('not read as this machine');
    console.log(`  scopes ${seen.scopes.join(' ')}`);
  });
} else console.log('Set OKTA_CLIENT_ID, OKTA_CLIENT_SECRET and OKTA_SCOPE to verify a real token.');
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
