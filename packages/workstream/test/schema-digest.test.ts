import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MayuraError, type Schema } from '@mayura/core';
import { defineWebhookTrigger, schemaDigest } from '../src/webhooks.js';
import { createHumanWorkStream, schemaDigest as humanSchemaDigest } from '../src/humans.js';
import { sqliteFixture, type WorkStreamFixture } from './fixtures.js';

const body = z.strictObject({ event: z.literal('ticket.created'), id: z.string() });
const opaque: Schema<unknown> = { '~standard': { version: 1, vendor: 'digest-test', validate: value => ({ value }) } };
const trigger = (options: { schemaDigest?: string; input?: Schema }) => defineWebhookTrigger({ id: 'tickets', version: '1', secretId: 'secret',
  schemaId: 'tickets.created.v1', input: options.input ?? body, dispatch: () => null, ...(options.schemaDigest === undefined ? {} : { schemaDigest: options.schemaDigest }) });

describe('webhook and human request schema digests', () => {
  let fixture: WorkStreamFixture | undefined;
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });

  it('derives a webhook trigger digest from its input validator and keeps an explicit one', () => {
    expect(humanSchemaDigest).toBe(schemaDigest);
    expect(trigger({}).schemaDigest).toBe(schemaDigest(body));
    expect(trigger({ schemaDigest: 'c'.repeat(64) }).schemaDigest).toBe('c'.repeat(64));
    expect(trigger({ schemaDigest: 'c'.repeat(64), input: opaque }).schemaDigest).toBe('c'.repeat(64));
    const error = (() => { try { trigger({ input: opaque }); } catch (caught) { return caught; } return undefined; })();
    expect(error).toBeInstanceOf(MayuraError);
    expect(error).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/"tickets" has no schemaDigest/) });
    expect(() => trigger({ schemaDigest: 'bad' })).toThrow(MayuraError);
  });

  it('derives a human request digest from its response validator', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize();
    const humans = createHumanWorkStream({ store: fixture.store, scope: { principalId: 'operator', projectId: 'project' }, streamId: 'review', authorize: () => true });
    await humans.initialize();
    const response = z.strictObject({ answer: z.string() });
    const base = { id: 'region', kind: 'information' as const, schemaId: 'region-answer-v1', prompt: 'Which region?', response };
    expect((await humans.request(base)).request.schemaDigest).toBe(schemaDigest(response));
    expect((await humans.request({ ...base, id: 'explicit', schemaDigest: 'd'.repeat(64) })).request.schemaDigest).toBe('d'.repeat(64));
    await expect(humans.request({ ...base, id: 'opaque', response: opaque })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/no schemaDigest/) });
  });
});
