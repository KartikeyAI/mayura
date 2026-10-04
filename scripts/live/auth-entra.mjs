// Live check of @mayurajs/auth-entra. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-entra.mjs
// Always checks Microsoft's public key sets and discovery documents are as the package expects. With ENTRA_TENANT_ID,
// ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET (an app exposing an API, its client id the audience), it gets an app-only
// token by client credentials and verifies it is refused without allowApps and accepted with it.
const root = new URL('../../', import.meta.url);
const { entraAuthenticator } = await import(new URL('extensions/auth-entra/dist/index.js', root).href);

const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
const json = async url => { const response = await fetch(url); if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return response.json(); };
await check('the v2.0 discovery document names the common v2.0 keys and the {tenantid} issuer template', async () => {
  const discovery = await json('https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration');
  if (discovery.jwks_uri !== 'https://login.microsoftonline.com/common/discovery/v2.0/keys') throw new Error(`jwks_uri ${discovery.jwks_uri}`);
  if (discovery.issuer !== 'https://login.microsoftonline.com/{tenantid}/v2.0') throw new Error(`issuer ${discovery.issuer}`);
});
await check('the v2.0 keys are RSA signing keys, and those naming an issuer name the template or one tenant', async () => {
  const { keys } = await json('https://login.microsoftonline.com/common/discovery/v2.0/keys');
  if (!keys.length || keys.some(key => key.kty !== 'RSA' || (key.use && key.use !== 'sig'))) throw new Error('unexpected keys');
  const odd = keys.filter(key => typeof key.issuer === 'string' && !/^https:\/\/login\.microsoftonline\.com\/(\{tenantid\}|[0-9a-f-]{36})\/v2\.0$/u.test(key.issuer));
  if (odd.length) throw new Error(`issuers ${odd.map(key => key.issuer).join()}`);
  console.log(`  ${keys.length} keys, ${keys.filter(key => key.issuer).length} naming an issuer`);
});
await check('the v1.0 discovery document names the common v1.0 keys and the sts.windows.net issuer', async () => {
  const discovery = await json('https://login.microsoftonline.com/common/.well-known/openid-configuration');
  if (discovery.jwks_uri !== 'https://login.microsoftonline.com/common/discovery/keys') throw new Error(`jwks_uri ${discovery.jwks_uri}`);
  if (discovery.issuer !== 'https://sts.windows.net/{tenantid}/') throw new Error(`issuer ${discovery.issuer}`);
  const { keys } = await json(discovery.jwks_uri);
  if (!keys.length || keys.some(key => key.kty !== 'RSA')) throw new Error('unexpected keys');
});
const { ENTRA_TENANT_ID: tenant, ENTRA_CLIENT_ID: clientId, ENTRA_CLIENT_SECRET: secret } = process.env;
if (tenant && clientId && secret) {
  await check('a real app-only token is refused without allowApps and verifies with it', async () => {
    const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: `api://${clientId}/.default` }) });
    if (!response.ok) throw new Error(`token HTTP ${response.status}`);
    const { access_token: token } = await response.json();
    let seen;
    const options = { tenants: [tenant], audience: [clientId, `api://${clientId}`], versions: ['1.0', '2.0'], identity: session => { seen = session; return { principalId: 'entra/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] }; } };
    if (await entraAuthenticator(options)({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('accepted an app-only token without allowApps');
    if (!await entraAuthenticator({ ...options, allowApps: true })({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused');
    console.log(`  version ${seen.version}, app ${seen.app}, roles ${seen.roles.length}`);
  });
} else console.log('Set ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET to verify a real token.');
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
