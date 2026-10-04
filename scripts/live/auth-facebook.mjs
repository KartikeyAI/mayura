// Live check of @mayurajs/auth-facebook. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-facebook.mjs
// Always checks Limited Login's published keys; with FACEBOOK_APP_ID and FACEBOOK_APP_SECRET it checks a made-up token is
// refused by Facebook, and with FACEBOOK_USER_TOKEN (a user access token for that app, from the Graph API Explorer) that a
// real one is accepted.
const root = new URL('../../', import.meta.url);
const { facebookAuthenticator } = await import(new URL('extensions/auth-facebook/dist/index.js', root).href);

const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
const grant = { principalId: 'facebook/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] };
await check('Limited Login publishes RS256 keys where its discovery document says', async () => {
  const discovery = await (await fetch('https://limited.facebook.com/.well-known/openid-configuration/')).json();
  if (discovery.issuer !== 'https://www.facebook.com' || discovery.jwks_uri !== 'https://www.facebook.com/.well-known/oauth/openid/jwks/') throw new Error(`issuer ${discovery.issuer}, jwks ${discovery.jwks_uri}`);
  const jwks = await (await fetch(discovery.jwks_uri)).json();
  if (!jwks.keys?.some(key => key.kty === 'RSA')) throw new Error('no RSA keys');
});
const { FACEBOOK_APP_ID: appId, FACEBOOK_APP_SECRET: appSecret, FACEBOOK_USER_TOKEN: token } = process.env;
if (appId && appSecret) {
  const authenticate = facebookAuthenticator({ appId, appSecret, identity: session => { console.log(`  user ${session.userId}, scopes ${session.scopes.join(' ')}`); return grant; } });
  await check('a made-up token is refused by Facebook', async () => {
    if (await authenticate({ token: `EAA${'x'.repeat(60)}`, signal: AbortSignal.timeout(10_000) })) throw new Error('accepted');
  });
  if (token) await check('a real user access token is accepted', async () => {
    if (!await authenticate({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused (expired, or for another app?)');
  });
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exitCode = results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0;
