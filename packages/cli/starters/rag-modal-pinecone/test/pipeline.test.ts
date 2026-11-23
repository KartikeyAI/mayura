import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openRag } from '../src/application.js';
import { hostedBackend, nomicDigest, readHostedSettings } from '../src/hosted.js';

const settings = readHostedSettings({
  RAG_MODAL_ENVIRONMENT: 'test', MODAL_TOKEN_ID: 'fixture-id', MODAL_TOKEN_SECRET: 'fixture-secret',
  RAG_MODAL_INFERENCE_TOKEN: 'fixture-inference-key', RAG_MODAL_INFERENCE_MODEL: 'fixture.us-west.modal.direct',
  RAG_PINECONE_HOST: 'https://index.example.pinecone.io', RAG_PINECONE_API_KEY: 'fixture-pinecone-key',
  RAG_INPUT_MICROS_PER_MILLION_TOKENS: '200000', RAG_OUTPUT_MICROS_PER_MILLION_TOKENS: '500000',
  RAG_INFERENCE_MAX_CALL_MICROS: '10000', RAG_MODAL_EMBED_CALL_MICROS: '100', RAG_PINECONE_CALL_MICROS: '100',
  RAG_PRINCIPAL_ID: 'operator', RAG_PROJECT_ID: 'handbook',
});
const vector = Array.from({ length: 768 }, (_, i) => Number(i === 0));

function services(options: { rejectEmbedding?: boolean; answerSources?: number[] } = {}) {
  const namespaces = new Map<string, Map<string, { id: string; metadata: Record<string, string> }>>();
  const calls: string[] = [];
  const seenEvidence: string[][] = [];
  const transport: typeof fetch = async (input, request) => {
    const url = new URL(String(input));
    const headers = new Headers(request?.headers);
    const body = JSON.parse(String(request?.body));
    if (url.origin === settings.pinecone) {
      assert.equal(headers.get('api-key'), settings.pineconeKey);
      assert.equal(headers.get('x-pinecone-api-version'), '2025-10');
      assert.equal(headers.has('authorization'), false);
      assert.match(body.namespace, /^[a-f0-9]{64}$/u);
      calls.push(url.pathname);
      if (url.pathname === '/vectors/upsert') {
        const indexed = namespaces.get(body.namespace) ?? new Map();
        for (const row of body.vectors) {
          assert.equal(row.metadata.mayuraNamespace, body.namespace);
          assert.deepEqual(row.values, vector);
          indexed.set(row.id, row);
        }
        namespaces.set(body.namespace, indexed);
        return Response.json({ upsertedCount: body.vectors.length });
      }
      assert.equal(url.pathname, '/query');
      assert.deepEqual(body.vector, vector);
      return Response.json({ matches: [...(namespaces.get(body.namespace)?.values() ?? [])].map(row => ({ ...row, score: 1 })) });
    }
    assert.equal(url.href, 'https://inference.us-west.modal.direct/v1/chat/completions');
    assert.equal(headers.get('authorization'), 'Bearer ' + settings.inferenceToken);
    assert.equal(headers.has('api-key'), false);
    assert.equal(body.model, settings.inferenceModel);
    assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(body.chat_template_kwargs, { thinking: false });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    const user = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
    const documents: string[] | undefined = user.documents;
    calls.push(documents ? 'rank' : 'answer');
    seenEvidence.push(documents ?? user.evidence);
    const output = documents ? { results: documents.map((_, index) => ({ index, score: 1 - index })) }
      : { answer: 'Post within 15 minutes.', sources: options.answerSources ?? [1] };
    return Response.json({
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 40, completion_tokens: 20 },
    });
  };
  const backend = hostedBackend(settings, async (role, texts) => {
    calls.push('embed:' + role);
    if (options.rejectEmbedding) throw new Error('Simulated lost acknowledgement');
    return { role, digest: nomicDigest, embeddings: texts.map(() => vector) };
  }, transport);
  return { backend, calls, seenEvidence };
}

test('ingests, restarts, reranks and answers with an exact active citation through hosted protocol fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-rag-'));
  const filename = join(directory, 'rag.sqlite');
  const host = services();
  const text = 'Post the incident summary within 15 minutes.';
  let app = await openRag(filename, settings.scope, host.backend);
  try {
    const original = await app.ingest('incident', 'incident.md', 'The old threshold was 30 minutes.');
    const indexed = await app.ingest('incident', 'incident.md', text);
    assert.notEqual(indexed.revision, original.revision);
    await app.close();
    app = await openRag(filename, settings.scope, host.backend);
    const unchanged = await app.ingest('incident', 'incident.md', text);
    assert.equal(unchanged.revision, indexed.revision);
    const same = await app.ask('When should the incident summary be posted?');
    assert.equal(same.answer, 'Post within 15 minutes.');
    assert.equal(same.citations.length, 1);
    const [citation] = same.citations;
    assert.equal(citation?.documentId, 'incident');
    assert.equal(citation.revision, indexed.revision);
    assert.equal(citation.reference, 'incident.md');
    assert.match(citation.chunkId, /^[a-f0-9]{64}$/u);
    assert.equal(text.slice(citation.start, citation.end), text);
    assert.deepEqual(host.seenEvidence, [[text], [text]]);
    assert.deepEqual(host.calls, ['embed:document', '/vectors/upsert', 'embed:document', '/vectors/upsert',
      'embed:query', '/query', 'rank', 'answer']);
    const other = await openRag(filename, { ...settings.scope, principalId: 'another-reader' }, host.backend);
    try { assert.deepEqual(await other.ask('When is the incident summary posted?'), { answer: null, citations: [] }); }
    finally { await other.close(); }
    assert.deepEqual(host.calls.slice(-2), ['embed:query', '/query']);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not disclose an answer when the model cites a passage outside the supplied list', async () => {
  const host = services({ answerSources: [2] });
  const app = await openRag(':memory:', settings.scope, host.backend);
  try {
    await app.ingest('incident', 'incident.md', 'Post the incident summary within 15 minutes.');
    await assert.rejects(app.ask('When is the incident summary posted?'), /invalid evidence references/u);
  } finally {
    await app.close();
  }
});

test('keeps an unacknowledged ingestion claim across restart without a second embedding or vector write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-rag-'));
  const filename = join(directory, 'rag.sqlite');
  const host = services({ rejectEmbedding: true });
  let app = await openRag(filename, settings.scope, host.backend);
  try {
    const ingest = () => app.ingest('incident', 'incident.md', 'Post the incident summary within 15 minutes.');
    await assert.rejects(ingest(), /did not publish/u);
    await app.close();
    app = await openRag(filename, settings.scope, host.backend);
    await assert.rejects(ingest(), /did not publish/u);
    assert.deepEqual(host.calls, ['embed:document']);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
