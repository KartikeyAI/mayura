// Live check of @mayurajs/auth-firebase. Run after pnpm build:
//   node --env-file=.env.live scripts/live/auth-firebase.mjs
// Always checks Google's key sets agree; with FIREBASE_PROJECT_ID and FIREBASE_WEB_API_KEY, and FIREBASE_TEST_EMAIL and
// FIREBASE_TEST_PASSWORD of a test user (email/password sign-in enabled), it signs in and verifies a real ID token.
const root = new URL('../../', import.meta.url);
const { firebaseAuthenticator, firebaseJwksUrl } = await import(new URL('extensions/auth-firebase/dist/index.js', root).href);

const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
await check('the JWKS and the X.509 certificates Firebase documents hold the same keys', async () => {
  const jwks = await (await fetch(firebaseJwksUrl)).json();
  const certificates = await (await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com')).json();
  const a = jwks.keys.map(key => key.kid).sort().join(); const b = Object.keys(certificates).sort().join();
  if (a !== b) throw new Error(`JWKS ${a} vs certificates ${b}`);
});
const { FIREBASE_PROJECT_ID: projectId, FIREBASE_WEB_API_KEY: apiKey, FIREBASE_TEST_EMAIL: email, FIREBASE_TEST_PASSWORD: password } = process.env;
if (projectId && apiKey && email && password) {
  await check('a real ID token verifies and reads as the user', async () => {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    if (!response.ok) throw new Error(`sign-in HTTP ${response.status}`);
    const { idToken } = await response.json();
    let seen;
    const authenticate = firebaseAuthenticator({ projectId, identity: session => { seen = session; return { principalId: 'firebase/live', projectId: 'live', agentIds: [], capabilities: ['runs:read'] }; } });
    if (!await authenticate({ token: idToken, signal: AbortSignal.timeout(10_000) })) throw new Error('refused');
    console.log(`  uid ${seen.userId}, provider ${seen.signInProvider}, verified ${seen.emailVerified}`);
  });
} else console.log('Set FIREBASE_PROJECT_ID, FIREBASE_WEB_API_KEY, FIREBASE_TEST_EMAIL and FIREBASE_TEST_PASSWORD to verify a real token.');
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
