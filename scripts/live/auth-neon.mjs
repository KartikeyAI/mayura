// Live check of @mayurajs/auth-neon against a real Neon Auth project. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-neon.mjs
// Needs NEON_AUTH_BASE_URL; optionally NEON_AUTH_TOKEN, a fresh JWT from your app (authClient.token(); they last 15 minutes).
const root = new URL('../../', import.meta.url);
const { neonAuthAuthenticator } = await import(new URL('extensions/auth-neon/dist/index.js', root).href);

const authUrl = process.env.NEON_AUTH_BASE_URL; const token = process.env.NEON_AUTH_TOKEN;
if (!authUrl) { console.log('NEON_AUTH_BASE_URL is not set; nothing run.'); process.exit(2); }
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
await check('the auth URL publishes Ed25519 keys', async () => {
  const response = await fetch(`${authUrl.replace(/\/$/, '')}/.well-known/jwks.json`);
  const jwks = await response.json();
  if (!response.ok || !jwks.keys?.some(key => key.kty === 'OKP' && key.crv === 'Ed25519')) throw new Error(`HTTP ${response.status}, keys ${JSON.stringify(jwks.keys?.map(key => key.kty))}`);
});
if (token) {
  await check('a real token verifies and reads as a user', async () => {
    let seen;
    const authenticate = neonAuthAuthenticator({ authUrl, identity: session => { seen = session; return { principalId: 'neon/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] }; } });
    if (!await authenticate({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused (expired? tokens last 15 minutes)');
    console.log(`  user ${seen.userId}, verified ${seen.emailVerified}, role ${seen.role}`);
  });
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
