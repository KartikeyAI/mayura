// Live check of @mayurajs/km-reqkey against a real ReqKey project. Run after pnpm build:
//   node --env-file=.env.live scripts/live/km-reqkey.mjs
// Needs REQKEY_ROOT_KEY, REQKEY_API_ID (an API registered in the project) and REQKEY_CONSUMER_ID (a consumer with a few
// credits). It creates a key for that consumer allowed only that API, verifies it (a free check and a paid one), checks
// another API and an unknown key are refused, then deletes the key it made.
const root = new URL('../../', import.meta.url);
const { reqkeyVerifier } = await import(new URL('extensions/km-reqkey/dist/index.js', root).href);

const { REQKEY_ROOT_KEY: rootKey, REQKEY_API_ID: apiId, REQKEY_CONSUMER_ID: consumerId } = process.env;
if (!rootKey || !apiId || !consumerId) { console.log('REQKEY_ROOT_KEY, REQKEY_API_ID or REQKEY_CONSUMER_ID is not set; nothing run.'); process.exit(2); }
const reqkey = async (path, body) => {
  const response = await fetch(`https://api.reqkey.com${path}`, { method: 'POST', headers: { authorization: `Bearer ${rootKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
const created = await reqkey('/key/create', { consumerId, allowedApis: [apiId], prefix: 'mlive_', tag: 'mayura-live', metadata: { live: true } });
console.log(`  created a key shaped ${created.key.replace(/[A-Za-z0-9]{6,}$/u, '…')}`);
const prefix = created.key.match(/^[A-Za-z0-9]+[_-]/u)?.[0] ?? 'mlive_';
const identity = key => ({ principalId: `reqkey/${key.consumerId}`, projectId: 'live', agentIds: [], capabilities: ['runs:read'] });
try {
  const verifier = reqkeyVerifier({ rootKey, prefix, apiId, identity });
  await check('a new key verifies for its API, read with its key and consumer ids', async () => {
    const free = await verifier.verify(created.key, { cost: 0 });
    const paid = await verifier.verify(created.key, { cost: 1 });
    if (!free.ok || !paid.ok || paid.principalId !== `reqkey/${consumerId}`) throw new Error(JSON.stringify({ free, paid }));
    if (free.remaining !== null && paid.remaining !== null && paid.remaining !== free.remaining - 1) throw new Error(`credits ${free.remaining} then ${paid.remaining}`);
  });
  await check('another API, and an unknown key, are refused', async () => {
    const other = await reqkeyVerifier({ rootKey, prefix, apiId: 'api_mayura_not_allowed', identity }).verify(created.key, { cost: 0 });
    const unknown = await verifier.verify(`${prefix}DoesNotExist1234567890`, { cost: 0 });
    if (other.ok || unknown.ok || unknown.reason !== 'not_found') throw new Error(JSON.stringify({ other, unknown }));
    console.log(`  another API: ${other.reason}`);
  });
} finally {
  await reqkey('/key/delete', { keyId: created.keyId }).catch(error => console.log(`  could not delete the test key: ${error.message}`));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
