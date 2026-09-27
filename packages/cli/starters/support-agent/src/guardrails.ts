import type { Guard, GuardContext, JsonValue } from 'mayura/core';
import { createPipeline, redactPII, type ContentProcessor, type ContentSnapshot } from 'mayura/guardrails';

// PII handling, in two layers:
//
// 1. Redaction. The agent's input and output schemas pass every chat text through one mayura/guardrails pipeline:
//    card numbers, email addresses and phone numbers become fixed labels. So the model (possibly a hosted provider)
//    never receives them, memory never stores them, and a reply never shows them, whatever the model wrote.
// 2. A fail-closed backstop. An output guard on the agent re-runs the same redaction over every tool result and every
//    final reply the runtime is about to release; if anything would still change, the content is withheld and the run
//    ends `blocked`.
//
// Agent guards can only allow or block, so the transforming step lives in the schemas; the guard proves it happened.
// These recognizers are heuristics (see mayura/guardrails `redactPII`): they miss unusual formats and can flag long
// digit strings that are not PII. They are a safety net, not a compliance certification.

export const redactionLabels = Object.freeze({ card: '[card removed]', email: '[email removed]', phone: '[phone removed]' });

/** Luhn check, so order numbers and other long digit strings that are not payment cards are left alone. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Payment card numbers: 13 to 19 digits, optionally grouped by single spaces or dashes, that pass the Luhn check. */
export function redactCardNumbers(): ContentProcessor {
  // Bounded repetition and word-boundary guards keep matching linear on digit-heavy text.
  const pattern = /(?<![\w])\d(?:[ -]?\d){12,18}(?![\w])/gu;
  const visit = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return value.replace(pattern, match => luhn(match.replace(/\D/gu, '')) ? redactionLabels.card : match);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    return value;
  };
  return Object.freeze({ id: 'support.redact-card-numbers', version: '1', process: (snapshot: ContentSnapshot) => visit(snapshot.value) });
}

// Cards first: a 13 to 15 digit card number would otherwise be caught (and mislabelled) by the phone recognizer.
const redaction = createPipeline({
  processors: [redactCardNumbers(), redactPII({ email: true, phone: true, emailReplacement: redactionLabels.email, phoneReplacement: redactionLabels.phone })],
  timeoutMs: 2_000,
  maxBytes: 262_144,
});

/** Redact card numbers, emails and phone numbers anywhere in a JSON value. Fails closed: an error never releases text. */
export async function redact<T extends JsonValue>(value: T, context: GuardContext): Promise<T> {
  const outcome = await redaction.process(value, context);
  if (outcome.status !== 'succeeded') throw new Error('Redaction could not complete.');
  return outcome.output.value as T;
}

/**
 * Schemas are validated without a run context, so schema-time redaction labels itself. The pipeline uses these fields
 * only to describe the boundary; it has no block callback, and nothing here grants authority.
 */
export function redactAtSchema(boundary: 'input' | 'output') {
  return <T extends JsonValue>(value: T): Promise<T> => redact(value, { runId: 'schema', callId: `${boundary}-schema`, boundary,
    scope: { principalId: 'support-service', projectId: 'schema' }, signal: AbortSignal.timeout(5_000) });
}

/** The backstop: withhold any tool result or reply that still contains something the redaction would change. */
export const piiBackstop: Guard = Object.freeze({
  id: 'support.pii-backstop',
  check: async (value: JsonValue, context: GuardContext) =>
    JSON.stringify(await redact(value, context)) === JSON.stringify(value) ? { decision: 'allow' as const } : { decision: 'block' as const },
});
