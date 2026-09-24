import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schema } from '@mayura/core';
import type { AggregateStore } from '@mayura/storage';
import { createHumanWorkStream, type HumanRequestDefinition, type HumanWorkStream } from '../src/humans.js';
import { createWorkStream } from '../src/index.js';
import type { WorkStreamFixture } from './fixtures.js';

interface Answer { readonly answer: string }
const responseSchema: Schema<Answer, Answer> = { '~standard': { version: 1, vendor: 'human-conformance',
  validate: value => value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { answer?: unknown }).answer === 'string'
    ? { value: { answer: (value as { answer: string }).answer.trim() } } : { issues: [{ message: 'private validation detail' }] },
} };
const hash = (character: string): string => character.repeat(64);
const scope = { principalId: 'operator', projectId: 'project' };

function definition(overrides: Partial<HumanRequestDefinition<typeof responseSchema>> = {}): HumanRequestDefinition<typeof responseSchema> {
  return { id: 'requirements', kind: 'information', schemaId: 'requirements-answer-v1', schemaDigest: hash('a'),
    prompt: 'Provide the production region.', response: responseSchema, ...overrides };
}

/** Human lifecycle evidence runs unchanged against each durable AggregateStore adapter. */
export function humanWorkStreamConformance(name: string, factory: () => Promise<WorkStreamFixture>): void {
  describe(`${name} typed human WorkStream conformance`, () => {
    let fixture: WorkStreamFixture; let store: AggregateStore; let now: number;
    let authorize: ReturnType<typeof vi.fn<(input: unknown, signal: AbortSignal) => boolean | Promise<boolean>>>;
    const create = (overrides: Partial<Parameters<typeof createHumanWorkStream>[0]> = {}): HumanWorkStream => createHumanWorkStream({
      store, scope, streamId: 'human-review', authorize, now: () => now, callbackTimeoutMs: 100, ...overrides,
    });
    const initialized = async (overrides: Partial<Parameters<typeof createHumanWorkStream>[0]> = {}): Promise<HumanWorkStream> => {
      const value = create(overrides); await value.initialize(); return value;
    };
    beforeEach(async () => {
      fixture = await factory(); store = fixture.store; await store.initialize(); now = 1_000;
      authorize = vi.fn(() => true);
    });
    afterEach(async () => { vi.restoreAllMocks(); await store?.close(); await fixture?.cleanup(); });

    it('persists an immutable typed request and admits one schema-normalized authorized response', async () => {
      const humans = await initialized(); const request = await humans.request(definition({ context: { environment: 'production' } }));
      expect(request).toMatchObject({ status: 'waiting', request: { kind: 'information', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }, response: null });
      expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.request)).toBe(true);
      expect(request.request).not.toHaveProperty('format');
      const answered = await humans.respond(definition({ context: { environment: 'production' } }), {
        commandId: 'answer-1', actor: { id: 'reviewer@example.org' }, value: { answer: '  eu-west-1  ' },
      });
      expect(answered).toMatchObject({ status: 'answered', response: { commandId: 'answer-1', actorId: 'reviewer@example.org', value: { answer: 'eu-west-1' } } });
      expect(Object.isFrozen(answered.response?.value)).toBe(true);
      expect(authorize).toHaveBeenCalledOnce();
      const authorization = authorize.mock.calls[0]![0] as { request: object; actor: object };
      expect(Object.isFrozen(authorization)).toBe(true); expect(Object.isFrozen(authorization.request)).toBe(true); expect(Object.isFrozen(authorization.actor)).toBe(true);

      const journal = createWorkStream({ store, scope, streamId: 'human-review', now: () => now }); await journal.initialize();
      const raw = JSON.stringify((await journal.signals({ limit: 100 })).items);
      expect(raw).not.toContain('token'); expect(raw).not.toContain('role');
    });

    it('survives process restart and requires the exact pinned definition to resume', async () => {
      const first = await initialized(); await first.request(definition());
      await store.close(); store = fixture.reopen(); await store.initialize();
      const restarted = await initialized();
      expect(await restarted.inspect(definition())).toMatchObject({ status: 'waiting' });
      await expect(restarted.inspect(definition({ prompt: 'Changed prompt.' }))).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
      expect(await restarted.respond(definition(), { commandId: 'after-restart', actor: { id: 'reviewer' }, value: { answer: 'ok' } })).toMatchObject({ status: 'answered' });
    });

    it('makes request and response retries exact and resolves concurrent responders once', async () => {
      const humans = await initialized(); const first = await humans.request(definition());
      expect(await humans.request(definition())).toEqual(first);
      const results = await Promise.allSettled([
        humans.respond(definition(), { commandId: 'response-a', actor: { id: 'reviewer-a' }, value: { answer: 'a' } }),
        humans.respond(definition(), { commandId: 'response-b', actor: { id: 'reviewer-b' }, value: { answer: 'b' } }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(await humans.inspect(definition())).toMatchObject({ status: 'answered' });
      const answered = await humans.inspect(definition());
      if (!answered?.response) throw new Error('fixture');
      expect(await humans.respond(definition(), { commandId: answered.response.commandId, actor: { id: answered.response.actorId }, value: answered.response.value })).toEqual(answered);
      await expect(humans.respond(definition(), { commandId: 'late-different', actor: { id: 'reviewer-c' }, value: { answer: 'different' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('denies unauthorized or invalid responses before adding a response signal', async () => {
      authorize.mockResolvedValue(false); const humans = await initialized(); await humans.request(definition());
      await expect(humans.respond(definition(), { commandId: 'denied', actor: { id: 'outsider' }, value: { answer: 'secret' } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      authorize.mockResolvedValue(true);
      await expect(humans.respond(definition(), { commandId: 'invalid', actor: { id: 'reviewer' }, value: {} as Answer })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      const journal = createWorkStream({ store, scope, streamId: 'human-review' }); await journal.initialize();
      expect((await journal.signals({ limit: 100 })).items).toHaveLength(1);
      expect(await humans.inspect(definition())).toMatchObject({ status: 'waiting' });
    });

    it('bounds non-cooperative authorization without exposing callback failures', async () => {
      authorize.mockImplementation(() => new Promise(() => undefined));
      const humans = await initialized({ callbackTimeoutMs: 5 }); await humans.request(definition());
      await expect(humans.respond(definition(), { commandId: 'slow', actor: { id: 'reviewer' }, value: { answer: 'ok' } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      authorize.mockRejectedValue(new Error('PRIVATE IDENTITY PROVIDER TOKEN'));
      const error: unknown = await humans.respond(definition(), { commandId: 'failed', actor: { id: 'reviewer' }, value: { answer: 'ok' } }).catch(caught => caught);
      expect(JSON.stringify(error)).not.toContain('PRIVATE');
    });

    it('binds corrections to an immutable subject digest', async () => {
      expect(() => definition({ kind: 'correction' })).not.toThrow();
      const humans = await initialized();
      await expect(humans.request(definition({ kind: 'correction' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      const correction = definition({ id: 'correction', kind: 'correction', subjectDigest: hash('b'), prompt: 'Correct the exact candidate.' });
      await humans.request(correction);
      await expect(humans.respond({ ...correction, subjectDigest: hash('c') }, { commandId: 'wrong-subject', actor: { id: 'reviewer' }, value: { answer: 'fixed' } })).rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
      expect(await humans.respond(correction, { commandId: 'corrected', actor: { id: 'reviewer' }, value: { answer: 'fixed' } })).toMatchObject({ status: 'answered' });
    });

    it('durably handles deadline, cancellation and late-response boundaries', async () => {
      const humans = await initialized();
      expect(await humans.request(definition({ id: 'expired', deadlineAtMs: now }))).toMatchObject({ status: 'timed_out' });
      await expect(humans.respond(definition({ id: 'expired', deadlineAtMs: now }), { commandId: 'late', actor: { id: 'reviewer' }, value: { answer: 'late' } })).resolves.toMatchObject({ status: 'timed_out', response: null });
      await humans.request(definition({ id: 'cancelled' }));
      expect(await humans.cancel('cancelled')).toMatchObject({ status: 'cancelled' });
      await expect(humans.respond(definition({ id: 'cancelled' }), { commandId: 'after-cancel', actor: { id: 'reviewer' }, value: { answer: 'late' } })).resolves.toMatchObject({ status: 'cancelled', response: null });
      const journal = createWorkStream({ store, scope, streamId: 'human-review' }); await journal.initialize();
      expect((await journal.signals({ limit: 100 })).items.filter(signal => signal.id.startsWith('human-response.'))).toHaveLength(0);
    });

    it('sweeps due requests with durable snapshots and leaves future requests waiting', async () => {
      const humans = await initialized();
      await humans.request(definition({ id: 'due', deadlineAtMs: 2_000 }));
      await humans.request(definition({ id: 'future', deadlineAtMs: 3_000 }));
      now = 2_500;
      expect(await humans.sweepDeadlines()).toMatchObject([{ status: 'timed_out', request: { id: 'due' } }]);
      expect(await humans.inspect(definition({ id: 'future', deadlineAtMs: 3_000 }))).toMatchObject({ status: 'waiting' });
    });

    it('separates identical stream and request IDs across verified scopes', async () => {
      const first = await initialized(); await first.request(definition());
      const second = await initialized({ scope: { principalId: 'operator', projectId: 'other-project' } });
      expect(await second.inspect(definition())).toBeUndefined();
      await second.request(definition());
      expect(await second.respond(definition(), { commandId: 'other-answer', actor: { id: 'other-reviewer' }, value: { answer: 'other' } })).toMatchObject({ status: 'answered' });
      expect(await first.inspect(definition())).toMatchObject({ status: 'waiting' });
    });

    it('rejects malformed definitions without persistence effects', async () => {
      const humans = await initialized();
      const invalid: readonly HumanRequestDefinition<typeof responseSchema>[] = [
        definition({ id: '../escape' }), definition({ schemaDigest: 'wrong' }), definition({ prompt: '' }),
        definition({ kind: 'information', subjectDigest: hash('a') }), definition({ deadlineAtMs: -1 }),
      ];
      for (const item of invalid) await expect(humans.request(item)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      const journal = createWorkStream({ store, scope, streamId: 'human-review' }); await journal.initialize();
      expect((await journal.signals({ limit: 100 })).items).toEqual([]);
    });
  });
}
