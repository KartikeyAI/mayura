// Live check of @mayurajs/km-unkey against a real Unkey workspace. Run after pnpm build:
//   node --env-file=.env.live scripts/live/km-unkey.mjs
// Needs UNKEY_ROOT_KEY (allowed to create, verify and delete keys in the API) and UNKEY_API_ID (api_...) and
// UNKEY_KEYSPACE_ID (that API's ks_...). It creates a key with 2 credits, verifies it until the credits run out, checks
// a key outside the keyspace filter and an unknown key are refused, then deletes the key it made.
const root = new URL('../../', import.meta.url);
const { unkeyVerifier } = await import(new URL('extensions/km-unkey/dist/index.js', root).href);

const { UNKEY_ROOT_KEY: rootKey, UNKEY_API_ID: apiId, UNKEY_KEYSPACE_ID: keyspace } = process.env;
if (!rootKey || !apiId || !keyspace) { console.log('UNKEY_ROOT_KEY, UNKEY_API_ID or UNKEY_KEYSPACE_ID is not set; nothing run.'); process.exit(2); }
const unkey = async (procedure, body) => {
  const response = await fetch(`https://api.unkey.com/v2/${procedure}`, { method: 'POST', headers: { authorization: `Bearer ${rootKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${procedure}: HTTP ${response.status}`);
  return (await response.json()).data;
};
const results = [];
const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.message}`]); } };
const created = await unkey('keys.createKey', { apiId, prefix: 'mlive', externalId: 'mayura-live', permissions: [], credits: { remaining: 2 }, meta: { live: true } });
const identity = key => key.identity ? { principalId: `unkey/${key.identity.externalId}`, projectId: 'live', agentIds: [], capabilities: ['runs:read'] } : null;
try {
  const verifier = unkeyVerifier({ rootKey, prefix: 'mlive', keyspaces: [keyspace], identity });
  await check('a new key verifies, read with its identity and credits', async () => {
    const result = await verifier.verify(created.key, { cost: 1 });
    if (!result.ok || result.principalId !== 'unkey/mayura-live' || result.remaining !== 1) throw new Error(JSON.stringify(result));
  });
  await check('a free check spends nothing, and the last credit then runs out', async () => {
    const free = await verifier.verify(created.key, { cost: 0 });
    if (!free.ok || free.remaining !== 1) throw new Error(JSON.stringify(free));
    const last = await verifier.verify(created.key, { cost: 1 });
    const out = await verifier.verify(created.key, { cost: 1 });
    if (!last.ok || out.ok || out.reason !== 'exhausted') throw new Error(JSON.stringify({ last, out }));
  });
  await check('a key outside the keyspaces asked for, and an unknown key, are refused', async () => {
    const other = await unkeyVerifier({ rootKey, prefix: 'mlive', keyspaces: ['ks_doesnotexist0000'], identity }).verify(created.key, { cost: 0 });
    const unknown = await verifier.verify('mlive_DoesNotExist1234567890', { cost: 0 });
    if (other.ok || other.reason !== 'not_found' || unknown.ok || unknown.reason !== 'not_found') throw new Error(JSON.stringify({ other, unknown }));
  });
  await check('a permission query the key does not meet is refused', async () => {
    const result = await unkeyVerifier({ rootKey, prefix: 'mlive', keyspaces: [keyspace], permissions: 'agents.admin', identity }).verify(created.key, { cost: 0 });
    if (result.ok || result.reason !== 'forbidden') throw new Error(JSON.stringify(result));
  });
} finally {
  await unkey('keys.deleteKey', { keyId: created.keyId }).catch(error => console.log(`  could not delete the test key: ${error.message}`));
}
for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
process.exit(results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0);
