// Live check of @mayurajs/auth-clerk against a real Clerk instance. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-clerk.mjs
// Needs CLERK_PUBLISHABLE_KEY and CLERK_AUTHORIZED_PARTY (the origin the token was made for); optionally CLERK_SESSION_TOKEN,
// a fresh session token (they last 60 s: in the browser, `await window.Clerk.session.getToken()`).
const root = new URL('../../', import.meta.url);
const { clerkAuthenticator, clerkFrontendApi } = await import(new URL('extensions/auth-clerk/dist/index.js', root).href);

const publishableKey = process.env.CLERK_PUBLISHABLE_KEY; const party = process.env.CLERK_AUTHORIZED_PARTY; const token = process.env.CLERK_SESSION_TOKEN;
if (!publishableKey || !party) { console.log('CLERK_PUBLISHABLE_KEY or CLERK_AUTHORIZED_PARTY is not set; nothing run.'); process.exit(2); }
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
const frontendApi = clerkFrontendApi(publishableKey);
await check('the Frontend API publishes RS256 keys', async () => {
  const response = await fetch(`${frontendApi}/.well-known/jwks.json`);
  const jwks = await response.json();
  if (!response.ok || !jwks.keys?.length || jwks.keys.some(key => key.kty !== 'RSA')) throw new Error(`HTTP ${response.status}, ${jwks.keys?.length} keys`);
});
let seen;
const authenticate = clerkAuthenticator({ publishableKey, authorizedParties: [party], identity: session => { seen = session; return { principalId: 'clerk/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] }; } });
if (token) {
  await check('a real session token verifies and reads as a session', async () => {
    const identity = await authenticate({ token, signal: AbortSignal.timeout(10_000) });
    if (!identity || !seen?.userId?.startsWith('user_')) throw new Error('refused (expired? tokens last 60 s)');
    console.log(`  user ${seen.userId}, org ${seen.orgId ?? 'none'}, role ${seen.orgRole ?? 'none'}, ${seen.orgPermissions.length} permissions, status ${seen.status}`);
  });
  await check('the same token for another origin is refused', async () => {
    const strict = clerkAuthenticator({ publishableKey, authorizedParties: ['https://not-yours.example'], identity: () => ({ principalId: 'x/y', projectId: 'p', agentIds: [], capabilities: [] }) });
    if (await strict({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('accepted');
  });
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
