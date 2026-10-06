// Shared by the storage-*.mjs live checks, for a hosted database you also use for other things: it migrates, writes
// and reads one record under a new id, and issues, verifies and revokes an API key in a namespace of its own. It never
// deletes anything; what it writes is listed at the end. Prints outcomes only; never a connection string or key.
const { createKeyManager } = await import(new URL('../../packages/mayura/dist/keys.js', import.meta.url).href);

export async function storageChecks(store) {
  const results = [];
  const check = async (name, body) => { try { await body(); results.push([name, 'passed']); } catch (error) { results.push([name, `FAILED: ${error.code ?? ''} ${String(error.message).slice(0, 200)}`]); } };
  const stamp = Date.now().toString(36);
  const scope = 'mayura-live'; const id = `live-${stamp}`; const namespace = `live-${stamp}`;
  try {
    await check('migrates the database', () => store.initialize());
    await check('writes a record and its event, reads them back, and creates it only once', async () => {
      const command = { scope, id, idempotencyKey: id, definitionHash: 'mayura-live-check', state: { value: 7 }, events: [{ type: 'live.created', data: { value: 7 } }] };
      const created = await store.create(command);
      if (!created.created) throw new Error('not created');
      const read = await store.read(scope, id);
      if (read?.state?.value !== 7 || read.version !== created.record.version) throw new Error(`read back ${JSON.stringify(read?.state)}`);
      const events = await store.events(scope, id);
      if (events.length !== 1 || events[0].type !== 'live.created') throw new Error(`${events.length} events`);
      if ((await store.create(command)).created) throw new Error('created twice');
    });
    await check('issues, verifies and revokes an API key', async () => {
      const keys = createKeyManager({ store, prefix: 'mlive', namespace });
      const { key, record } = await keys.create({ projectId: 'mayura-live', ownerId: 'user/live', agentIds: ['support'], capabilities: ['runs:read'] });
      const verified = await keys.verify(key);
      if (!verified.ok || verified.projectId !== 'mayura-live') throw new Error(`verify ${JSON.stringify(verified)}`);
      await keys.revoke(record.keyId);
      const after = await keys.verify(key);
      if (after.ok || after.reason !== 'revoked') throw new Error(`after revoke ${JSON.stringify(after)}`);
    });
  } finally { await store.close().catch(() => undefined); }
  console.log(`  wrote: record ${scope}/${id}, and key records in namespace ${namespace}`);
  return results;
}

export function report(results) {
  for (const [name, outcome] of results) console.log(`${outcome === 'passed' ? 'PASS' : 'FAIL'} ${name}${outcome === 'passed' ? '' : ` (${outcome})`}`);
  process.exitCode = results.some(([, outcome]) => outcome !== 'passed') ? 1 : 0;
}
