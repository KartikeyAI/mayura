import { createHash } from 'node:crypto';
import type { JsonValue, ModelAdapter, ModelRequest, ModelResponse } from '@mayura/core';
import { createNativeMemory } from '@mayura/memory';
import { MayuraError, defineAgent, defineTool, type ToolExecutionContext } from '@mayura/sdk';
import type { MemoryIndexStore } from '@mayura/storage-contracts';
import { z } from 'zod';
import { customerFromScope } from './auth.js';
import type { ModelSettings } from './config.js';
import { piiBackstop, redact, redactAtSchema } from './guardrails.js';
import { jsonSchema, selectModel } from './model.js';
import type { Order, OrderDirectory } from './orders.js';
import type { ReturnsDesk } from './returns.js';

export const assistantId = 'support.assistant';
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);

// ---- What the chat sends and receives -------------------------------------------------------------------------------

const turn = z.strictObject({ role: z.enum(['customer', 'assistant']), text: z.string().min(1).max(4_000) });
/** One customer message plus the recent conversation (the browser keeps it and sends at most 20 turns). */
export const supportInputWire = z.strictObject({ message: z.string().min(1).max(2_000), history: z.array(turn).max(20) });
export type SupportInput = z.infer<typeof supportInputWire>;
/** The agent's input: the same shape, with card numbers, emails and phone numbers redacted before the model sees it. */
const supportInput = supportInputWire.transform(redactAtSchema('input'));

const referenceItem = z.strictObject({ kind: z.enum(['order', 'return', 'note']), id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u) });
/** The reply, and the order, return and note ids it relied on (the UI can link them). */
export const supportOutputWire = z.strictObject({ reply: z.string().min(1).max(4_000), references: z.array(referenceItem).max(10) });
export type SupportOutput = z.infer<typeof supportOutputWire>;
/** The agent's output: whatever the model wrote, redacted again before it is released (see src/guardrails.ts). */
const supportOutput = supportOutputWire.transform(redactAtSchema('output'));

// ---- Tool contracts -------------------------------------------------------------------------------------------------

const orderSummary = z.strictObject({ orderId: identifier, placedAt: z.string(), status: z.enum(['processing', 'shipped', 'delivered']),
  items: z.array(z.string().max(200)).max(50), totalCents: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/u), deliveryDate: z.string().nullable() });
const orderDetail = orderSummary.extend({ carrier: z.string().nullable(), trackingNumber: z.string().nullable(),
  tracking: z.array(z.strictObject({ at: z.string(), description: z.string().max(500) })).max(50) });

const listInput = z.strictObject({});
export const listOutput = z.strictObject({ orders: z.array(orderSummary).max(20) });
const trackInput = z.strictObject({ orderId: identifier });
export const trackOutput = z.union([z.strictObject({ found: z.literal(true), order: orderDetail }), z.strictObject({ found: z.literal(false), orderId: identifier })]);
const returnInput = z.strictObject({ orderId: identifier, reason: z.string().min(1).max(500) });
export const returnOutput = z.strictObject({ status: z.enum(['opened', 'already_open', 'not_eligible', 'not_found']), orderId: identifier,
  orderStatus: z.enum(['processing', 'shipped', 'delivered']).nullable(), returnId: identifier.nullable(), instructions: z.string().max(1_000).nullable() });
const rememberInput = z.strictObject({ fact: z.string().min(3).max(500), category: z.enum(['fact', 'preference']) });
export const rememberOutput = z.strictObject({ status: z.enum(['saved', 'already_known']), noteId: identifier, fact: z.string().max(4_096) });
const recallInput = z.strictObject({ query: z.string().min(1).max(200).optional() });
const note = z.strictObject({ noteId: z.string().max(128), category: z.string().max(32), fact: z.string().max(4_096), rememberedAt: z.string() });
export const recallOutput = z.strictObject({ notes: z.array(note).max(20) });

export interface AssistantDependencies {
  readonly model: ModelSettings;
  /** Replaces the configured model entirely (tests use it to play a hostile or scripted model). */
  readonly modelOverride?: ModelAdapter;
  readonly projectId: string;
  readonly orders: OrderDirectory;
  readonly returns: ReturnsDesk;
  /** The application store; native memory lives in its `memory` capability, partitioned per customer scope. */
  readonly store: { readonly memory: MemoryIndexStore };
  /** Start (or find) the durable follow-up for one return. Idempotent on `returnId`. */
  readonly startFollowUp: (request: { readonly returnId: string; readonly customerId: string; readonly orderId: string }) => Promise<void>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const summary = (order: Order): z.infer<typeof orderSummary> => ({ orderId: order.orderId, placedAt: order.placedAt, status: order.status,
  items: [...order.items], totalCents: order.totalCents, currency: order.currency, deliveryDate: order.deliveryDate });

export function supportAssistant(dependencies: AssistantDependencies) {
  /**
   * The signed-in customer, from the verified run scope. This is the whole authorization story of the tools: no tool
   * takes a customer id as input (their schemas are strict), so a model cannot name another customer even if it tries.
   */
  const customerOf = (context: ToolExecutionContext): string => {
    const customerId = customerFromScope(context.scope, dependencies.projectId);
    if (!customerId) throw new MayuraError('PERMISSION_DENIED', 'Support tools act only for a signed-in customer.');
    return customerId;
  };
  const ownOrder = async (customerId: string, orderId: string): Promise<Order | undefined> =>
    (await dependencies.orders.ordersFor(customerId)).find(order => order.orderId === orderId);
  /** Native memory in the customer's own scope: another customer's notes are not merely filtered out, they are elsewhere. */
  const memoryOf = (context: ToolExecutionContext, allow: readonly string[]) =>
    createNativeMemory({ store: dependencies.store, scope: context.scope, permissions: { allow } });
  const guardContext = (context: ToolExecutionContext) =>
    ({ runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal, boundary: 'input' as const });

  const list = defineTool({
    id: 'orders.list', version: '1', effects: 'read', capabilities: [],
    description: 'List the signed-in customer\'s orders, newest first, with status and expected or actual delivery date.',
    input: listInput, inputJsonSchema: jsonSchema(listInput), output: listOutput,
    execute: async (_input, context) => ({ orders: (await dependencies.orders.ordersFor(customerOf(context))).slice(0, 20).map(summary) }),
  });

  const track = defineTool({
    id: 'orders.track', version: '1', effects: 'read', capabilities: [],
    description: 'Tracking details for one of the signed-in customer\'s orders. Returns found=false for any order that is not theirs.',
    input: trackInput, inputJsonSchema: jsonSchema(trackInput), output: trackOutput,
    execute: async ({ orderId }, context) => {
      const order = await ownOrder(customerOf(context), orderId);
      // Someone else's order and a nonexistent one look the same, so the tool never confirms that an order exists.
      if (!order) return { found: false as const, orderId };
      return { found: true as const, order: { ...summary(order), carrier: order.carrier, trackingNumber: order.trackingNumber,
        tracking: order.tracking.map(event => ({ at: event.at, description: event.description })) } };
    },
  });

  const startReturn = defineTool({
    id: 'returns.start', version: '1', effects: 'write', capabilities: ['returns:start'],
    description: 'Open a return for one of the signed-in customer\'s delivered orders. Safe to repeat: an open return is found, not duplicated.',
    input: returnInput, inputJsonSchema: jsonSchema(returnInput), output: returnOutput,
    execute: async ({ orderId, reason }, context) => {
      const customerId = customerOf(context); const order = await ownOrder(customerId, orderId);
      if (!order) return { status: 'not_found' as const, orderId, orderStatus: null, returnId: null, instructions: null };
      if (order.status !== 'delivered') return { status: 'not_eligible' as const, orderId, orderStatus: order.status, returnId: null, instructions: null };
      const opened = await dependencies.returns.open({ customerId, orderId, reason: await redact(reason, guardContext(context)) });
      // Idempotent on the return id: a retried call finds the follow-up it already started.
      await dependencies.startFollowUp({ returnId: opened.returnId, customerId, orderId });
      return { status: opened.created ? 'opened' as const : 'already_open' as const, orderId, orderStatus: order.status,
        returnId: opened.returnId, instructions: opened.instructions };
    },
  });

  const remember = defineTool({
    id: 'memory.remember', version: '1', effects: 'write', capabilities: ['memory:write'],
    description: 'Remember one lasting fact or preference the customer asked you to remember, for future conversations.',
    input: rememberInput, inputJsonSchema: jsonSchema(rememberInput), output: rememberOutput,
    execute: async ({ fact, category }, context) => {
      // Never persist PII, even if the model put some into the note.
      const content = (await redact(fact, guardContext(context))).trim();
      const noteId = `note-${sha256(content.toLowerCase()).slice(0, 24)}`;
      const observedAt = new Date().toISOString();
      try {
        await memoryOf(context, ['memory:write']).add({ id: noteId, content, category, sensitivity: 'internal',
          // Provenance: which conversation said it, and that it is the customer's own statement.
          provenance: { sourceId: 'support-chat', reference: `run/${context.runId}`, revision: '1', sha256: sha256(content),
            author: context.scope.principalId, observedAt, origin: 'observed', confidence: 1 } });
        return { status: 'saved' as const, noteId, fact: content };
      } catch (error) {
        // The note id is derived from its content, so remembering the same thing twice is a no-op.
        if (error instanceof MayuraError && error.code === 'CONFLICT') return { status: 'already_known' as const, noteId, fact: content };
        throw error;
      }
    },
  });

  const recall = defineTool({
    id: 'memory.recall', version: '1', effects: 'read', capabilities: ['memory:read'],
    description: 'Look up what you remembered about the signed-in customer. Without a query, returns the most recent notes.',
    input: recallInput, inputJsonSchema: jsonSchema(recallInput), output: recallOutput,
    execute: async ({ query }, context) => {
      const memory = memoryOf(context, ['memory:read']);
      let records;
      try { records = query ? (await memory.search(query, { limit: 10 })).hits.map(hit => hit.record) : undefined; }
      catch (error) { if (!(error instanceof MayuraError && error.code === 'INVALID_INPUT')) throw error; }
      if (!records || records.length === 0) {
        const page = await memory.list({ limit: 50 });
        records = page.records.flatMap(entry => entry.status === 'active' ? [entry] : [])
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 20);
      }
      return { notes: records.map(record => ({ noteId: record.id, category: record.category, fact: record.content, rememberedAt: record.createdAt })) };
    },
  });

  const model = dependencies.modelOverride
    ?? selectModel(dependencies.model, { outputJsonSchema: jsonSchema(supportOutputWire), offline: offlineSupportModel });
  const tools = [list, track, startReturn, remember, recall];
  const agent = defineAgent({
    id: assistantId, version: '1', input: supportInput, output: supportOutput, tools, model,
    // Checked on every tool result and on the final reply before either is released.
    guards: { output: [piiBackstop] },
    instructions: [
      'You are the customer support assistant of an online store, chatting with one signed-in customer.',
      'The input holds the customer\'s new `message` and the recent conversation `history`.',
      'Use tools for every fact: orders.list for their orders, orders.track for one order\'s tracking, returns.start to open a return for a delivered order,',
      'memory.remember to save a lasting fact or preference the customer asks you to remember, and memory.recall to look up what you saved before.',
      'The tools always act for the signed-in customer. You cannot see or act on anyone else\'s orders; do not ask for another person\'s details.',
      'Open a return only when the customer asks for one. Never invent orders, tracking events, dates or policies.',
      'Card numbers, email addresses and phone numbers are removed before you see the conversation; never ask the customer to repeat them.',
      'Reply in plain text, briefly and warmly. List the order, return and note ids you relied on in `references`.',
    ].join('\n'),
  });
  const permissions = [...tools.flatMap(tool => [`tool:${tool.id}`, ...tool.capabilities]), 'effect:read', 'effect:write'];
  return { agent, model, permissions: [...new Set(permissions)] } as const;
}

// ---- Offline stand-in -----------------------------------------------------------------------------------------------
// RULE-BASED AND DETERMINISTIC, NOT A LANGUAGE MODEL. Keyword intents drive the same tool-call protocol a real model
// follows, and the reply is assembled from the tool results. It exists so the starter runs and tests without a network.

type Plan = { readonly call: { readonly toolId: string; readonly input: JsonValue } } | { readonly final: SupportOutput };
type Results = ReadonlyMap<string, JsonValue>;

const orderPattern = /\bord-\d{3,8}\b/iu;
const money = (cents: number, currency: string): string => `${(cents / 100).toFixed(2)} ${currency}`;
const day = (iso: string): string => iso.slice(0, 10);
const items = (list: readonly string[]): string => list.join(', ');

function intentOf(message: string): 'remember' | 'return' | 'track' | 'recall' | 'help' {
  const text = message.trim().toLowerCase();
  if (/^(?:please\s+|can you\s+|could you\s+)?remember(?:\s+that)?\s+\S.{2,}$/u.test(text) && !text.endsWith('?')) return 'remember';
  if (/\b(?:returns?|send (?:[\w-]+ ){0,4}back|refund)\b/u.test(text)) return 'return';
  if (/\b(?:where|track|tracking|shipping|shipped|deliver|delivery|delivered|arrive|status|parcel|package)\b/u.test(text)) return 'track';
  if (/\b(?:remember|know about me|notes?)\b/u.test(text)) return 'recall';
  return 'help';
}

function trackReply(result: z.infer<typeof trackOutput>, orders: z.infer<typeof listOutput> | undefined): SupportOutput {
  if (!result.found) return { reply: `I couldn't find an order ${result.orderId} on your account. Ask me "what are my orders?" to see the ones I can help with.`, references: [] };
  const order = result.order; const latest = order.tracking.at(-1);
  const parts = [order.status === 'processing'
    ? `Order ${order.orderId} (${items(order.items)}) is being prepared and hasn't shipped yet.`
    : order.status === 'shipped'
      ? `Order ${order.orderId} (${items(order.items)}) is on its way with ${order.carrier ?? 'the carrier'}${order.trackingNumber ? `, tracking ${order.trackingNumber}` : ''}.`
      : `Order ${order.orderId} (${items(order.items)}) was delivered${order.deliveryDate ? ` on ${order.deliveryDate}` : ''}.`];
  if (latest && order.status !== 'delivered') parts.push(`Latest update (${day(latest.at)}): ${latest.description}.`);
  if (order.status !== 'delivered' && order.deliveryDate) parts.push(`Expected delivery: ${order.deliveryDate}.`);
  const others = (orders?.orders ?? []).filter(other => other.orderId !== order.orderId && other.status !== 'delivered');
  if (others.length > 0) parts.push(`Also on the way: ${others.map(other => `${other.orderId} (${other.status})`).join(', ')}.`);
  return { reply: parts.join(' '), references: [order, ...others].slice(0, 10).map(entry => ({ kind: 'order' as const, id: entry.orderId })) };
}

function returnReply(result: z.infer<typeof returnOutput>): SupportOutput {
  const references = [{ kind: 'order' as const, id: result.orderId }, ...(result.returnId ? [{ kind: 'return' as const, id: result.returnId }] : [])];
  switch (result.status) {
    case 'opened': return { reply: `I've opened return ${result.returnId} for order ${result.orderId}. ${result.instructions ?? ''}`.trim(), references };
    case 'already_open': return { reply: `You already have return ${result.returnId} open for order ${result.orderId}. ${result.instructions ?? ''}`.trim(), references };
    case 'not_eligible': return { reply: `Order ${result.orderId} hasn't been delivered yet (it's ${result.orderStatus}), so it can't be returned yet. Once it arrives, just ask again.`, references };
    case 'not_found': return { reply: `I couldn't find an order ${result.orderId} on your account, so I can't open a return for it.`, references: [] };
  }
}

function notesReply(result: z.infer<typeof recallOutput>, asked: boolean): SupportOutput {
  const help = 'I can track your orders, open a return for a delivered order, and remember your preferences for next time. Try "Where is my order?" or "Remember that I prefer weekend deliveries."';
  const references = result.notes.slice(0, 10).map(entry => ({ kind: 'note' as const, id: entry.noteId }));
  if (result.notes.length === 0) return { reply: asked ? 'I don\'t have any notes about you yet. Say "Remember that ..." and I will.' : help, references: [] };
  const listed = result.notes.slice(0, 5).map(entry => `- ${entry.fact}`).join('\n');
  return { reply: asked ? `Here's what I remember about you:\n${listed}` : `${help}\n\nWhat I remember about you:\n${listed}`, references };
}

/** Decide the next step from the message and the tool results so far. */
function plan(input: SupportInput, results: Results): Plan {
  const intent = intentOf(input.message); const mentioned = orderPattern.exec(input.message)?.[0].toLowerCase();
  const orders = results.has('orders.list') ? listOutput.parse(results.get('orders.list')) : undefined;
  switch (intent) {
    case 'remember': {
      if (results.has('memory.remember')) {
        const saved = rememberOutput.parse(results.get('memory.remember'));
        return { final: { reply: saved.status === 'saved' ? `Got it. I'll remember that: "${saved.fact}".` : `I already have that noted: "${saved.fact}".`,
          references: [{ kind: 'note', id: saved.noteId }] } };
      }
      const fact = input.message.trim().replace(/^(?:please\s+|can you\s+|could you\s+)?remember(?:\s+that)?\s+/iu, '').replace(/[.!\s]+$/u, '').slice(0, 500);
      const category = /\b(?:prefer|rather|like|love|hate|don't|do not|always|never|please)\b/iu.test(fact) ? 'preference' : 'fact';
      return { call: { toolId: 'memory.remember', input: { fact, category } } };
    }
    case 'return': {
      if (results.has('returns.start')) return { final: returnReply(returnOutput.parse(results.get('returns.start'))) };
      if (mentioned) return { call: { toolId: 'returns.start', input: { orderId: mentioned, reason: input.message.slice(0, 500) } } };
      if (!orders) return { call: { toolId: 'orders.list', input: {} } };
      const delivered = orders.orders.find(order => order.status === 'delivered');
      if (!delivered) return { final: { reply: 'None of your orders has been delivered yet, so there is nothing to return. Ask me where your order is.', references: [] } };
      return { call: { toolId: 'returns.start', input: { orderId: delivered.orderId, reason: input.message.slice(0, 500) } } };
    }
    case 'track': {
      if (results.has('orders.track')) return { final: trackReply(trackOutput.parse(results.get('orders.track')), orders) };
      if (mentioned) return { call: { toolId: 'orders.track', input: { orderId: mentioned } } };
      if (!orders) return { call: { toolId: 'orders.list', input: {} } };
      const open = orders.orders.find(order => order.status !== 'delivered');
      if (open) return { call: { toolId: 'orders.track', input: { orderId: open.orderId } } };
      const latest = orders.orders[0];
      return { final: latest
        ? { reply: `All your orders have been delivered. The most recent, ${latest.orderId} (${items(latest.items)}, ${money(latest.totalCents, latest.currency)}), arrived on ${latest.deliveryDate ?? 'its delivery date'}.`, references: [{ kind: 'order', id: latest.orderId }] }
        : { reply: 'I don\'t see any orders on your account yet.', references: [] } };
    }
    case 'recall':
    case 'help':
      if (results.has('memory.recall')) return { final: notesReply(recallOutput.parse(results.get('memory.recall')), intent === 'recall') };
      return { call: { toolId: 'memory.recall', input: {} } };
  }
}

export const offlineSupportModel: ModelAdapter = {
  id: 'offline.support-assistant',
  capabilities: { tools: true, structuredOutput: true },
  maxCostMicros: 0,
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const first = request.messages[0];
    const input = supportInputWire.parse(first?.role === 'user' ? first.content : undefined);
    const results = new Map<string, JsonValue>();
    for (const message of request.messages) if (message.role === 'tool') results.set(message.toolId, message.result);
    const next = plan(input, results);
    if ('final' in next) return { type: 'final', output: next.final, usage: { costMicros: 0 } };
    const step = request.messages.filter(message => message.role === 'assistant').length + 1;
    return { type: 'tool_calls', calls: [{ id: `call-${step}`, toolId: next.call.toolId, input: next.call.input }], usage: { costMicros: 0 } };
  },
};
