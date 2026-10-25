import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

class QualificationFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new QualificationFailure(code); };
const integer = (value, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_CONFIG');
  return value;
};
const codeOf = error => error instanceof QualificationFailure ? error.code : 'ADAPTER_FAILED';

/** A deadline bounds the observer even if an adapter ignores cancellation; writes are never retried. */
async function bounded(operation, parent, timeoutMs) {
  const controller = new AbortController();
  const relay = () => controller.abort();
  parent.addEventListener('abort', relay, { once: true });
  if (parent.aborted) relay();
  const timer = setTimeout(relay, timeoutMs);
  let abort;
  try {
    if (controller.signal.aborted) fail('CANCELLED');
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        abort = () => reject(new QualificationFailure(parent.aborted ? 'CANCELLED' : 'DEADLINE'));
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer); parent.removeEventListener('abort', relay);
    if (abort) controller.signal.removeEventListener('abort', abort);
  }
}

/**
 * Opt-in qualification against host-supplied VectorStore/RagReranker adapters.
 * Requires rag:qualify and funds the worst-case operation count, including cleanup,
 * before the first call. Only synthetic public fixtures in fresh namespaces are used.
 * Offline evidence never qualifies live compatibility. Errors contain static codes only.
 *
 * @param {{mode:'offline'|'live', permissions:{allow:readonly string[]}, profiles:readonly {
 *   id:string, kind:'vector'|'reranker', adapter:import('../../packages/rag/src/contracts.ts').VectorStore|import('../../packages/rag/src/contracts.ts').RagReranker
 * }[], maxCostMicros:number, maxOperations:number, maxDurationMs?:number,
 * maxReadAttempts?:number, visibilityDelayMs?:number, cleanupTimeoutMs?:number, signal?:AbortSignal}} options
 */
export async function qualifyRagAdapters(options) {
  if (!Array.isArray(options?.permissions?.allow) || !options.permissions.allow.includes('rag:qualify')) fail('PERMISSION_DENIED');
  if (!['offline', 'live'].includes(options.mode) || !Array.isArray(options.profiles)
    || options.profiles.length < 1 || options.profiles.length > 16) fail('INVALID_CONFIG');
  const maxCostMicros = integer(options.maxCostMicros, 0, Number.MAX_SAFE_INTEGER);
  const maxOperations = integer(options.maxOperations, 1, 10_000);
  const duration = integer(options.maxDurationMs ?? 60_000, 1, 300_000);
  const attempts = integer(options.maxReadAttempts ?? 3, 1, 10);
  const delay = integer(options.visibilityDelayMs ?? 250, 0, 5_000);
  const cleanupTimeout = integer(options.cleanupTimeoutMs ?? 10_000, 1, 30_000);
  const profiles = options.profiles.map(profile => ({ ...profile, costMicros: profile?.adapter?.costMicros }));
  const names = new Set(); let requiredOperations = 0; let requiredCost = 0n;
  for (const profile of profiles) {
    if (!profile || typeof profile.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(profile.id)
      || names.has(profile.id) || !['vector', 'reranker'].includes(profile.kind)) fail('INVALID_CONFIG');
    names.add(profile.id);
    const adapter = profile.adapter;
    if (!adapter || !['local', 'hosted'].includes(adapter.location)) fail('INVALID_CONFIG');
    integer(adapter.costMicros, 0, Number.MAX_SAFE_INTEGER);
    if (profile.kind === 'vector') {
      integer(adapter.dimensions, 2, 4_096);
      if (['upsert', 'query', 'delete'].some(key => typeof adapter[key] !== 'function')) fail('INVALID_CONFIG');
    } else if (typeof adapter.rank !== 'function') fail('INVALID_CONFIG');
    const operations = profile.kind === 'vector' ? 14 + 14 * attempts : 3;
    requiredOperations += operations; requiredCost += BigInt(operations) * BigInt(adapter.costMicros);
  }
  if (requiredOperations > maxOperations) fail('OPERATION_LIMIT');
  if (requiredCost > BigInt(maxCostMicros)) fail('BUDGET_EXCEEDED');
  const controller = new AbortController(); const relay = () => controller.abort();
  options.signal?.addEventListener('abort', relay, { once: true });
  if (options.signal?.aborted) relay();
  const timer = setTimeout(relay, duration); const startedAt = new Date().toISOString();
  let operations = 0; let reservedCostMicros = 0;
  const results = [];
  try {
    for (const profile of profiles) {
      if (controller.signal.aborted) break;
      const result = { id: profile.id, kind: profile.kind, location: profile.adapter.location,
        ...(profile.kind === 'vector' ? { dimensions: profile.adapter.dimensions } : {}),
        costMicros: profile.costMicros, status: 'passed', checks: [], cleanup: 'not-needed' };
      const adapter = profile.adapter;
      const invoke = async (body, signal = controller.signal) => {
        if (signal.aborted) fail('CANCELLED');
        if (++operations > maxOperations) fail('OPERATION_LIMIT');
        reservedCostMicros += profile.costMicros;
        if (reservedCostMicros > maxCostMicros) fail('BUDGET_EXCEEDED');
        return bounded(body, signal, signal === controller.signal ? duration : cleanupTimeout);
      };
      const check = async (name, body) => {
        try { await body(); result.checks.push({ name, status: 'passed' }); }
        catch (error) { result.checks.push({ name, status: 'failed', code: codeOf(error) }); throw error; }
      };
      const mustReject = async (body, expectedCode) => {
        // Only an adapter rejection proves the contract; observer timeouts must fail.
        const rejected = await invoke(async signal => {
          try { await body(signal); return false; } catch (error) { return error?.code === expectedCode; }
        });
        if (!rejected) fail('CONTRACT_FAILED');
      };
      const wait = async (read, predicate, signal = controller.signal) => {
        for (let attempt = 0; attempt < attempts; attempt++) {
          const value = await read(signal); if (predicate(value)) return value;
          if (attempt + 1 < attempts && delay) await bounded(waitSignal => new Promise(resolve => {
            const finish = () => { clearTimeout(timer); waitSignal.removeEventListener('abort',finish); resolve(); };
            const timer = setTimeout(finish, delay);
            waitSignal.addEventListener('abort', finish, { once: true });
            if (waitSignal.aborted) finish();
          }), signal, delay + 100);
        }
        fail('VISIBILITY_TIMEOUT');
      };
      if (profile.kind === 'reranker') {
        try {
          const query = 'Which planet is known as the red planet?';
          const documents = ['Mars is called the red planet.', 'Bananas are a fruit.', 'Venus has a dense atmosphere.'];
          await check('ranking-original-indexes', async () => {
            const rows = await invoke(signal => adapter.rank(query, documents, signal));
            if (!Array.isArray(rows) || rows.length !== documents.length
              || rows.some(row => !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= documents.length || !Number.isFinite(row.score))
              || new Set(rows.map(row => row.index)).size !== documents.length
              || [...rows].sort((a,b) => b.score-a.score)[0].index !== 0) fail('CONTRACT_FAILED');
          });
          const cancelled = new AbortController(); cancelled.abort();
          await check('pre-cancelled-ranking', () => mustReject(() => adapter.rank(query, documents, cancelled.signal), 'CANCELLED'));
          await check('invalid-query', () => mustReject(signal => adapter.rank('', documents, signal), 'INVALID_INPUT'));
        } catch { result.status = 'failed'; }
      } else {
        const nonce = `ragq-${randomUUID()}`;
        const alice = { principalId: `${nonce}-a`, projectId: nonce };
        const bob = { principalId: `${nonce}-b`, projectId: nonce };
        const project = { principalId: alice.principalId, projectId: `${nonce}-other` };
        const space = `${nonce}-one`; const otherSpace = `${nonce}-two`;
        const chunk = (id,topic,owner) => ({ id, documentId: nonce, revision: 'a'.repeat(64), text: 'Public qualification fixture.',
          reference: `https://example.invalid/${nonce}/${owner}`, metadata: { topic }, sensitivity: 'public', start: 0, end: 29 });
        const one = chunk('one','A','alice'); const two = chunk('two','B','alice');
        const vector = (a,b) => [a,b,...Array(adapter.dimensions-2).fill(0)];
        const partitions = [
          { scope:alice,space,chunks:[one,two],entries:[{chunk:one,values:vector(1,0)},{chunk:two,values:vector(0.8,0.6)}] },
          { scope:bob,space,chunks:[chunk('one','A','bob')] },
          { scope:project,space,chunks:[chunk('one','A','project')] },
          { scope:alice,space:otherSpace,chunks:[chunk('one','A','index')] },
        ];
        const touched = []; let uncertainWrite = false;
        const write = async body => {
          try { return await invoke(body); } catch (error) { uncertainWrite = true; throw error; }
        };
        const read = async (partition,signal,filter={}) => {
          const rows = await invoke(signal => adapter.query({ scope:partition.scope,space:partition.space,vector:vector(1,0),limit:filter.topic ? 1 : 10,filter,signal }),signal);
          const allowed = partition.chunks.filter(chunk => !filter.topic || chunk.metadata.topic === filter.topic);
          if (!Array.isArray(rows) || new Set(rows.map(row => row.chunk?.id)).size !== rows.length
            || rows.some(row => !Number.isFinite(row.score) || !allowed.some(chunk => isDeepStrictEqual(row.chunk,chunk)))) fail('CONTRACT_FAILED');
          return rows;
        };
        result.fixture = { namespace: nonce, partitions: partitions.map(({scope,space,chunks}) => ({scope,space,ids:chunks.map(chunk=>chunk.id)})) };
        try {
          await check('scoped-write-and-visibility', async () => {
            for (const partition of partitions) {
              touched.push(partition);
              await write(signal => adapter.upsert(partition.scope,partition.space,partition.entries ?? partition.chunks.map(chunk=>({chunk,values:vector(1,0)})),signal));
            }
            for (const partition of partitions) await wait(signal => read(partition,signal), rows=>rows.length===partition.chunks.length);
          });
          await check('filter-before-top-k', () => wait(signal => read(partitions[0],signal,{topic:'B'}),rows=>rows.length===1&&rows[0].chunk.id==='two'));
          await check('id-replacement', async () => {
            await write(signal => adapter.upsert(alice,space,[{chunk:one,values:vector(0.6,0.8)}],signal));
            await wait(signal => read(partitions[0],signal),rows=>rows.length===2&&rows[0].chunk.id==='two');
          });
          await check('scoped-delete-and-visibility', async () => {
            await write(signal => adapter.delete(alice,space,['one'],signal));
            await wait(signal => read(partitions[0],signal),rows=>rows.length===1&&rows[0].chunk.id==='two');
            for (const partition of partitions.slice(1)) await wait(signal => read(partition,signal),rows=>rows.length===1);
          });
          const cancelled = new AbortController(); cancelled.abort();
          await check('pre-cancelled-operations', async () => {
            await mustReject(() => adapter.upsert(alice,space,[{chunk:one,values:vector(1,0)}],cancelled.signal), 'CANCELLED');
            await mustReject(() => adapter.query({scope:alice,space,vector:vector(1,0),limit:1,filter:{},signal:cancelled.signal}), 'CANCELLED');
            await mustReject(() => adapter.delete(alice,space,['two'],cancelled.signal), 'CANCELLED');
          });
          await check('invalid-dimensions', () => mustReject(signal => adapter.query({scope:alice,space,vector:[1],limit:1,filter:{},signal}), 'INVALID_INPUT'));
        } catch { result.status = 'failed'; }
        finally {
          result.cleanup = 'passed';
          const cleanup = new AbortController(); const cleanupTimer = setTimeout(()=>cleanup.abort(),cleanupTimeout);
          try {
            for (const partition of touched) {
              await invoke(signal => adapter.delete(partition.scope,partition.space,partition.chunks.map(chunk=>chunk.id),signal),cleanup.signal);
              await wait(signal => read(partition,signal),rows=>rows.length===0,cleanup.signal);
            }
          } catch { result.cleanup = 'failed'; result.status = 'failed'; }
          finally { clearTimeout(cleanupTimer); }
          if (uncertainWrite) { result.cleanup = 'unconfirmed'; result.status = 'failed'; }
        }
      }
      results.push(result);
    }
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort',relay); }
  return { format:1,kind:'rag-qualification',mode:options.mode,startedAt,completedAt:new Date().toISOString(),
    status:controller.signal.aborted?'cancelled':results.every(result=>result.status==='passed')?'passed':'failed',
    profiles:results,notRun:profiles.slice(results.length).map(profile=>profile.id),operations,reservedCostMicros,requiredOperations,requiredCostMicros:Number(requiredCost) };
}
