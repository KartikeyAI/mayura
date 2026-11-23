import { pineconeVectorStore } from '@mayurajs/vector-pinecone';
import { ModalClient } from 'modal';
import type { Scope } from 'mayura/core';
import { openAICompatibleChat, type OpenAICompatibleChatOptions } from 'mayura/provider-openai';
import { modelReranker, ragEmbedder } from 'mayura/rag';
import type { Backend } from './application.js';

export const nomicDigest = '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f';
const dimensions = 768;
const batchSize = 8;
const timeoutMs = 30_000;
const inferenceEndpoint = 'https://inference.us-west.modal.direct/v1/chat/completions';
type Role = 'document' | 'query';
type Embed = (role: Role, texts: readonly string[]) => Promise<unknown>;

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error('Set ' + name + ' to use the hosted starter.');
  return value;
}

function micros(env: NodeJS.ProcessEnv, name: string) {
  const value = required(env, name);
  const amount = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER / 16) {
    throw new Error(name + ' must be a positive, bounded integer in USD micros.');
  }
  return amount;
}

function pineconeEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.pinecone.io') || url.port
      || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('RAG_PINECONE_HOST must be the HTTPS data-plane origin of a Pinecone index.');
  }
  return url.origin;
}

export function readHostedSettings(env: NodeJS.ProcessEnv) {
  const inferenceModel = required(env, 'RAG_MODAL_INFERENCE_MODEL');
  const filename = env['RAG_SQLITE_PATH']?.trim() || '.data/rag.sqlite';
  if (filename === ':memory:') throw new Error('Hosted ingestion requires a durable SQLite filename.');
  if (!/^(?:[a-z0-9-]+\.)+us-west\.modal\.direct$/u.test(inferenceModel)) {
    throw new Error('RAG_MODAL_INFERENCE_MODEL must be the reviewed Modal Shared Endpoint hostname.');
  }
  return {
    app: env['RAG_MODAL_APP']?.trim() || 'mayura-rag-nomic-v1',
    environment: required(env, 'RAG_MODAL_ENVIRONMENT'),
    modalTokenId: required(env, 'MODAL_TOKEN_ID'),
    modalTokenSecret: required(env, 'MODAL_TOKEN_SECRET'),
    inferenceToken: required(env, 'RAG_MODAL_INFERENCE_TOKEN'),
    inferenceModel,
    modelCost: micros(env, 'RAG_INFERENCE_MAX_CALL_MICROS'),
    pricing: {
      inputMicrosPerMillionTokens: micros(env, 'RAG_INPUT_MICROS_PER_MILLION_TOKENS'),
      outputMicrosPerMillionTokens: micros(env, 'RAG_OUTPUT_MICROS_PER_MILLION_TOKENS'),
    },
    pinecone: pineconeEndpoint(required(env, 'RAG_PINECONE_HOST')),
    pineconeKey: required(env, 'RAG_PINECONE_API_KEY'),
    storageCost: micros(env, 'RAG_PINECONE_CALL_MICROS'),
    embedCost: micros(env, 'RAG_MODAL_EMBED_CALL_MICROS'),
    scope: { principalId: required(env, 'RAG_PRINCIPAL_ID'), projectId: required(env, 'RAG_PROJECT_ID') } satisfies Scope,
    filename,
  };
}

type HostedSettings = ReturnType<typeof readHostedSettings>;

function nomicEmbedder(role: Role, invoke: Embed, costMicros: number) {
  return ragEmbedder({
    id: 'nomic-embed-text-v1.5-' + nomicDigest,
    dimensions, maxBatch: batchSize, location: 'hosted',
    async embed(texts, signal) {
      signal.throwIfAborted();
      const raw = await invoke(role, texts);
      signal.throwIfAborted();
      if (!raw || typeof raw !== 'object') throw new Error('Invalid Modal Nomic response.');
      const result = raw as { role?: unknown; digest?: unknown; embeddings?: unknown };
      const vectors = result.embeddings;
      if (result.role !== role || result.digest !== nomicDigest || !Array.isArray(vectors) || vectors.length !== texts.length
          || vectors.some(vector => !Array.isArray(vector) || vector.length !== dimensions
            || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
        throw new Error('Modal responded with a different model, embedding role or vector shape.');
      }
      return vectors;
    },
  }, { costMicros });
}

/** Build the deployed pipeline from explicit credentials and transport ports. No client calls occur here. */
export function hostedBackend(settings: HostedSettings, invoke: Embed, transport?: typeof fetch): Backend {
  const modelOptions: OpenAICompatibleChatOptions = {
    endpoint: inferenceEndpoint, remote: { id: 'modal-deepseek' }, model: settings.inferenceModel,
    apiKey: settings.inferenceToken, output: 'json_object', pricing: settings.pricing,
    body: { temperature: 0, reasoning_effort: 'none', chat_template_kwargs: { thinking: false }, separate_reasoning: false },
    maxCostMicros: settings.modelCost, timeoutMs, ...(transport ? { fetch: transport } : {}),
  };
  // The compatible adapter requires closed objects at every level, even in JSON-object mode.
  const rankingModel = openAICompatibleChat({ ...modelOptions, outputJsonSchema: {
    type: 'object', additionalProperties: false, required: ['results'],
    properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { index: { type: 'integer' }, score: { type: 'number' } }, required: ['index', 'score'] } } },
  } });
  return {
    identity: settings.pinecone,
    store: pineconeVectorStore({
      endpoint: settings.pinecone, collection: 'mayura-rag', dimensions, costMicros: settings.storageCost,
      headers: { 'Api-Key': settings.pineconeKey, 'X-Pinecone-API-Version': '2025-10' },
      permissions: { allow: ['rag:transport:pinecone'] }, timeoutMs, maxConcurrent: 1,
      ...(transport ? { fetch: transport } : {}),
    }),
    documents: nomicEmbedder('document', invoke, settings.embedCost),
    queries: nomicEmbedder('query', invoke, settings.embedCost),
    reranker: modelReranker({ model: rankingModel, permissions: { allow: ['model:' + rankingModel.id] }, location: 'hosted' }),
    answerModel: () => openAICompatibleChat(modelOptions),
  };
}

export function connectHosted(settings: HostedSettings) {
  const client = new ModalClient({
    tokenId: settings.modalTokenId, tokenSecret: settings.modalTokenSecret,
    endpoint: 'https://api.modal.com:443', timeoutMs, maxRetries: 0,
  });
  let lookup: ReturnType<typeof client.functions.fromName> | undefined;
  const backend = hostedBackend(settings, async (role, texts) => {
    lookup ??= client.functions.fromName(settings.app, 'embed', { environment: settings.environment });
    try {
      const worker = await lookup;
      // An unacknowledged execution leaves Mayura's original durable claim for reconciliation.
      return await worker.remote([role, [...texts]]);
    } catch {
      throw new Error('Private Modal Nomic worker did not acknowledge the request.');
    }
  });
  return { backend, close: () => client.close() };
}
