// Live check of @mayurajs/auth-google. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-google.mjs
// Always checks Google's ID token keys; with GOOGLE_CLIENT_ID and GOOGLE_ID_TOKEN (a fresh ID token for that client, from Google
// Identity Services or the OAuth playground; they last an hour) it verifies a real token.
const root = new URL('../../', import.meta.url);
const { googleAuthenticator, googleJwksUrl } = await import(new URL('extensions/auth-google/dist/index.js', root).href);

const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
await check('Google publishes RS256 keys for ID tokens, with a max-age', async () => {
  const response = await fetch(googleJwksUrl);
  const jwks = await response.json();
  if (!response.ok || !jwks.keys?.length || jwks.keys.some(key => key.kty !== 'RSA')) throw new Error(`HTTP ${response.status}`);
  if (!/max-age=\d+/.test(response.headers.get('cache-control') ?? '')) throw new Error('no max-age');
});
const { GOOGLE_CLIENT_ID: clientId, GOOGLE_ID_TOKEN: token } = process.env;
if (clientId && token) {
  await check('a real ID token verifies and reads as the account', async () => {
    let seen;
    const authenticate = googleAuthenticator({ clientIds: clientId, identity: session => { seen = session; return { principalId: 'google/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] }; } });
    if (!await authenticate({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused (expired, or for another client?)');
    console.log(`  account ${seen.userId}, verified ${seen.emailVerified}, domain ${seen.hostedDomain ?? 'consumer'}`);
  });
} else console.log('Set GOOGLE_CLIENT_ID and GOOGLE_ID_TOKEN to verify a real token.');
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
