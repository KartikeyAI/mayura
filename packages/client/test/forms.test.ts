import { describe, expect, it } from 'vitest';
import { ClientError, type RemoteHumanRequest } from '../src/index.js';
import { createHumanResponseController, defineHumanResponseForm, validateHumanResponse } from '../src/forms.js';

const schemaDigest = 'a'.repeat(64); const requestDigest = 'b'.repeat(64);
const request = (overrides: Partial<RemoteHumanRequest> = {}): RemoteHumanRequest => Object.freeze({
  id: 'review', agentId: 'agent', kind: 'information', schemaId: 'review-v1', schemaDigest,
  prompt: 'Review the deployment.', digest: requestDigest, status: 'waiting', ...overrides,
});
const definition = () => defineHumanResponseForm({ schemaId: 'review-v1', schemaDigest, fields: [
  { kind: 'text', name: 'summary', label: 'Summary', required: true, minLength: 2, maxLength: 20 },
  { kind: 'textarea', name: 'evidence', label: 'Evidence', maxLength: 100 },
  { kind: 'integer', name: 'risk', label: 'Risk', required: true, minimum: 1, maximum: 5 },
  { kind: 'number', name: 'confidence', label: 'Confidence', minimum: 0, maximum: 1 },
  { kind: 'boolean', name: 'approved', label: 'Approved', required: true },
  { kind: 'select', name: 'region', label: 'Region', required: true, options: [{ value: 'eu', label: 'Europe' }, { value: 'us', label: 'United States' }] },
] });
const shortDefinition = () => defineHumanResponseForm({ schemaId: 'review-v1', schemaDigest,
  fields: [{ kind: 'text', name: 'answer', label: 'Answer', required: true }] });
const shortSubmission = () => validateHumanResponse(request(), shortDefinition(), Object.freeze({ answer: 'Safe' }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe('human response forms', () => {
  it('captures an exact deeply frozen definition without retaining caller arrays', () => {
    const fields = [{ kind: 'text' as const, name: 'answer', label: 'Answer' }];
    const form = defineHumanResponseForm({ schemaId: 'review-v1', schemaDigest, fields }); fields[0]!.label = 'Changed';
    expect(form.fields).toEqual([{ kind: 'text', name: 'answer', label: 'Answer', required: false, minLength: 0, maxLength: 4_096 }]);
    expect(Object.isFrozen(form)).toBe(true); expect(Object.isFrozen(form.fields)).toBe(true); expect(form.fields.every(Object.isFrozen)).toBe(true);
  });

  it('converts a frozen browser draft and binds it to the exact request identity', () => {
    const submission = validateHumanResponse(request(), definition(), Object.freeze({ summary: 'Safe', evidence: 'Receipt attached', risk: '3',
      confidence: '0.75', approved: false, region: 'eu' }));
    expect(submission).toEqual({ id: 'review', digest: requestDigest,
      value: { summary: 'Safe', evidence: 'Receipt attached', risk: 3, confidence: 0.75, approved: false, region: 'eu' } });
    expect(Object.isFrozen(submission)).toBe(true); expect(Object.isFrozen(submission.value)).toBe(true); expect(Object.getPrototypeOf(submission.value)).toBeNull();
  });

  it('rejects stale, resolved, mutable and schema-mismatched request boundaries', () => {
    const form = definition(); const draft = Object.freeze({ summary: 'Safe', risk: '3', approved: true, region: 'eu' });
    expect(() => validateHumanResponse(request({ status: 'answered' }), form, draft)).toThrow(expect.objectContaining({ code: 'INVALID_FORM_VALUE' }));
    expect(() => validateHumanResponse(request({ schemaDigest: 'c'.repeat(64) }), form, draft)).toThrow(expect.objectContaining({ code: 'INVALID_FORM_VALUE' }));
    expect(() => validateHumanResponse({ ...request() }, form, draft)).toThrow(expect.objectContaining({ code: 'INVALID_FORM_VALUE' }));
    expect(() => validateHumanResponse(request(), form, { ...draft })).toThrow(expect.objectContaining({ code: 'INVALID_FORM_VALUE' }));
  });

  it('rejects missing, unknown and invalid typed values', () => {
    const form = definition(); const invalid = (draft: Readonly<Record<string, string | boolean>>) =>
      expect(() => validateHumanResponse(request(), form, Object.freeze(draft))).toThrow(expect.objectContaining({ code: 'INVALID_FORM_VALUE' }));
    invalid({ risk: '3', approved: true, region: 'eu' });
    invalid({ summary: 'Safe', risk: '3', approved: true, region: 'eu', extra: 'forbidden' });
    invalid({ summary: 'Safe', risk: '3.5', approved: true, region: 'eu' });
    invalid({ summary: 'Safe', risk: '6', approved: true, region: 'eu' });
    invalid({ summary: 'Safe', risk: '3', approved: true, region: 'apac' });
    invalid({ summary: 'Safe', risk: '3', approved: 'true', region: 'eu' });
  });

  it('rejects forged definitions, accessor fields and unsafe names', () => {
    const form = definition(); const clone = Object.freeze({ ...form }); const draft = Object.freeze({ summary: 'Safe', risk: '3', approved: true, region: 'eu' });
    expect(() => validateHumanResponse(request(), clone, draft)).toThrow(expect.objectContaining({ code: 'INVALID_FORM_VALUE' }));
    expect(() => defineHumanResponseForm({ schemaId: 'review-v1', schemaDigest, fields: [Object.defineProperty({}, 'kind', { get: () => 'text' }) as never] }))
      .toThrow(expect.objectContaining({ code: 'INVALID_FORM_CONFIG' }));
    expect(() => defineHumanResponseForm({ schemaId: 'review-v1', schemaDigest, fields: [{ kind: 'text', name: '__proto__', label: 'Unsafe' }] }))
      .toThrow(expect.objectContaining({ code: 'INVALID_FORM_CONFIG' }));
  });

  it('bounds Unicode scalar values, encoded size and numeric parsing', () => {
    const form = defineHumanResponseForm({ schemaId: 'review-v1', schemaDigest, fields: [{ kind: 'text', name: 'answer', label: 'Answer', maxLength: 2 }] });
    expect(validateHumanResponse(request(), form, Object.freeze({ answer: '🦚🦚' })).value).toEqual({ answer: '🦚🦚' });
    expect(() => validateHumanResponse(request(), form, Object.freeze({ answer: '🦚🦚🦚' }))).toThrow(expect.objectContaining({ code: 'INVALID_FORM_VALUE' }));
    const numeric = defineHumanResponseForm({ schemaId: 'review-v1', schemaDigest, fields: [{ kind: 'number', name: 'answer', label: 'Answer' }] });
    expect(() => validateHumanResponse(request(), numeric, Object.freeze({ answer: 'Infinity' }))).toThrow(expect.objectContaining({ code: 'INVALID_FORM_VALUE' }));
  });

  it('keeps response commands inert until explicit submit and publishes immutable success state once', async () => {
    const calls: unknown[][] = []; const answered = request({ status: 'answered' });
    const controller = createHumanResponseController({ request: request(), client: { respondHumanRequest: async (...args) => { calls.push(args); return answered; } } });
    const revisions: number[] = []; controller.subscribe(() => revisions.push(controller.getSnapshot().revision));
    expect(controller.getSnapshot()).toMatchObject({ revision: 0, status: 'idle', requestId: 'review', requestDigest, errorCode: null }); expect(calls).toHaveLength(0);
    await expect(controller.submit(shortSubmission(), { commandId: 'response-1' })).resolves.toBe(answered);
    expect(calls).toHaveLength(1); expect(calls[0]?.slice(0, 3)).toEqual(['review', requestDigest, { answer: 'Safe' }]);
    expect(controller.getSnapshot()).toMatchObject({ status: 'succeeded', responseStatus: 'answered', errorCode: null });
    expect(Object.isFrozen(controller.getSnapshot())).toBe(true); expect(revisions).toEqual([1, 2]); controller.dispose();
  });

  it('enforces single flight and never retries an ambiguous failure', async () => {
    const pending = deferred<RemoteHumanRequest>(); let calls = 0;
    const controller = createHumanResponseController({ request: request(), client: { respondHumanRequest: () => { calls += 1; return pending.promise; } } });
    const first = controller.submit(shortSubmission(), { commandId: 'response-1' });
    await expect(controller.submit(shortSubmission(), { commandId: 'response-1' })).rejects.toMatchObject({ code: 'FORM_BUSY' });
    pending.reject(new Error('PRIVATE TRANSPORT DETAIL')); await expect(first).rejects.toMatchObject({ code: 'FORM_SUBMISSION_FAILED' });
    expect(calls).toBe(1); expect(controller.getSnapshot()).toMatchObject({ status: 'failed', errorCode: 'FORM_SUBMISSION_FAILED' });
  });

  it('classifies digest conflicts without exposing transport details and requires explicit reset', async () => {
    let calls = 0; const controller = createHumanResponseController({ request: request(), client: { respondHumanRequest: async () => {
      calls += 1; throw new ClientError('HTTP_ERROR', 409); } } });
    await expect(controller.submit(shortSubmission(), { commandId: 'response-1' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 409 });
    expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', errorCode: 'FORM_SUBMISSION_CONFLICT' }); expect(calls).toBe(1);
    expect(controller.reset()).toMatchObject({ status: 'idle', errorCode: null }); expect(calls).toBe(1);
  });

  it('rejects forged or rebound submissions and aborts owned transport on disposal', async () => {
    let observed: AbortSignal | undefined; const pending = deferred<RemoteHumanRequest>();
    const controller = createHumanResponseController({ request: request(), client: { respondHumanRequest: async (_id, _digest, _value, options) => {
      observed = options.signal; return await pending.promise; } } });
    await expect(controller.submit(Object.freeze({ id: 'review', digest: requestDigest, value: Object.freeze({ answer: 'Safe' }) }),
      { commandId: 'response-1' })).rejects.toMatchObject({ code: 'INVALID_FORM_SUBMISSION' });
    const running = controller.submit(shortSubmission(), { commandId: 'response-1' }); controller.dispose();
    expect(observed?.aborted).toBe(true); expect(controller.getSnapshot().status).toBe('disposed');
    pending.reject(new ClientError('ABORTED')); await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(controller.submit(shortSubmission(), { commandId: 'response-2' })).rejects.toMatchObject({ code: 'FORM_DISPOSED' });
  });
});
