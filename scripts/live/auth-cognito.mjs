// Live check of @mayurajs/auth-cognito against a real user pool. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-cognito.mjs
// Needs COGNITO_USER_POOL_ID. With COGNITO_DOMAIN (the pool's domain, such as acme.auth.us-east-1.amazoncognito.com),
// COGNITO_CLIENT_ID, COGNITO_CLIENT_SECRET and COGNITO_SCOPE of an app client with client credentials and a resource
// server scope, it gets a real machine access token and checks it is refused without allowMachines and verifies with it.
const root = new URL('../../', import.meta.url);
const { cognitoAuthenticator } = await import(new URL('extensions/auth-cognito/dist/index.js', root).href);

const { COGNITO_USER_POOL_ID: userPoolId, COGNITO_DOMAIN: domain, COGNITO_CLIENT_ID: clientId, COGNITO_CLIENT_SECRET: secret, COGNITO_SCOPE: scope } = process.env;
if (!userPoolId) { console.log('COGNITO_USER_POOL_ID is not set; nothing run.'); process.exit(2); }
const issuer = `https://cognito-idp.${userPoolId.split('_')[0]}.amazonaws.com/${userPoolId}`;
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
await check('the pool names itself the issuer and publishes RS256 keys where the package looks', async () => {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  const metadata = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (metadata.issuer !== issuer || metadata.jwks_uri !== `${issuer}/.well-known/jwks.json`) throw new Error(`issuer ${metadata.issuer}, jwks_uri ${metadata.jwks_uri}`);
  const jwks = await (await fetch(metadata.jwks_uri)).json();
  if (!jwks.keys?.length || jwks.keys.some(key => key.kty !== 'RSA' || key.alg !== 'RS256')) throw new Error('unexpected keys');
});
if (domain && clientId && secret && scope) {
  await check('a client-credentials access token is refused without allowMachines and verifies with it', async () => {
    const response = await fetch(`https://${domain}/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope }) });
    if (!response.ok) throw new Error(`token HTTP ${response.status}`);
    const { access_token: token } = await response.json();
    let seen;
    const options = { userPoolId, clientIds: [clientId], identity: session => { seen = session; return { principalId: 'cognito/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] }; } };
    if (await cognitoAuthenticator(options)({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('accepted a machine token without allowMachines');
    if (!await cognitoAuthenticator({ ...options, allowMachines: true })({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused');
    if (!seen.machine || seen.clientId !== clientId) throw new Error('not read as this machine');
    console.log(`  scopes ${seen.scopes.join(' ')}`);
  });
} else console.log('Set COGNITO_DOMAIN, COGNITO_CLIENT_ID, COGNITO_CLIENT_SECRET and COGNITO_SCOPE to verify a real token.');
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
