// Live check of @mayurajs/auth-supabase against a real Supabase project. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-supabase.mjs
// Needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY); with SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD of a
// test user, it signs in and verifies the real access token.
const root = new URL('../../', import.meta.url);
const { supabaseAuthenticator } = await import(new URL('extensions/auth-supabase/dist/index.js', root).href);

const projectUrl = process.env.SUPABASE_URL; const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const email = process.env.SUPABASE_TEST_EMAIL; const password = process.env.SUPABASE_TEST_PASSWORD;
if (!projectUrl || !apiKey) { console.log('SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY is not set; nothing run.'); process.exit(2); }
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
const grant = { principalId: 'supabase/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] };
await check('the project publishes asymmetric keys (if it has moved off the legacy secret)', async () => {
  const response = await fetch(`${projectUrl}/auth/v1/.well-known/jwks.json`);
  const jwks = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log(`  ${jwks.keys?.length ?? 0} keys: ${(jwks.keys ?? []).map(key => key.alg ?? key.kty).join(', ') || 'none (legacy secret only: give jwtSecret)'}`);
});
await check('the publishable/anon key is never a user', async () => {
  const authenticate = supabaseAuthenticator({ projectUrl, identity: () => grant });
  if (apiKey.split('.').length === 3 && await authenticate({ token: apiKey, signal: AbortSignal.timeout(10_000) })) throw new Error('accepted');
});
if (email && password) {
  await check('a signed-in user\'s access token verifies and reads as the user', async () => {
    const response = await fetch(`${projectUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!response.ok) throw new Error(`sign-in HTTP ${response.status}`);
    const { access_token: token } = await response.json();
    let seen;
    const authenticate = supabaseAuthenticator({ projectUrl, identity: session => { seen = session; return grant; } });
    if (!await authenticate({ token, signal: AbortSignal.timeout(10_000) })) throw new Error('refused (a project on the legacy secret needs jwtSecret)');
    console.log(`  user ${seen.userId}, role ${seen.role}, aal ${seen.aal}, session ${seen.sessionId ? 'present' : 'absent'}`);
  });
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
