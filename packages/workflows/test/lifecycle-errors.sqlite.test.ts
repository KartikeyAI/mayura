import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError, type JsonValue, type Schema } from '@mayura/core';
import { StorageError } from '@mayura/storage-contracts';
import { defineTool } from '@mayura/tools';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createWorkflowSagaRuntime, defineWorkflowSaga } from '../src/sagas.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'lifecycle-errors-test', validate: value => ({ value: value as JsonValue }) } };
const echo = defineTool({ id: 'errors/echo', version: '1', description: 'Echo.', input: any, output: any, effects: 'none', capabilities: [], execute: input => input });
const definition = defineWorkflowLifecycle({ id: 'errors', version: '1', input: any, output: any,
  nodes: [{ kind: 'tool', id: 'echo', tool: echo, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'echo', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };

describe('workflow storage failures are MayuraErrors that say what to do', () => {
  let fixture: WorkflowFixture | undefined;
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });
  const runtime = (store: WorkflowFixture['store'], maxCostMicros = 0) => createWorkflowLifecycleRuntime({ store, scope,
    permissions: { allow: ['tool:errors/echo'] }, policyVersion: '1', maxCostMicros });

  it('reports a reused idempotency key with other input or settings as that, not as a storage version change', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize();
    const first = await runtime(fixture.store).submit(definition, { input: 'a', idempotencyKey: 'order-1' });
    // The identical request returns the same run.
    expect((await runtime(fixture.store).submit(definition, { input: 'a', idempotencyKey: 'order-1' })).id).toBe(first.id);
    for (const attempt of [() => runtime(fixture!.store).submit(definition, { input: 'b', idempotencyKey: 'order-1' }),
      () => runtime(fixture!.store, 5).submit(definition, { input: 'a', idempotencyKey: 'order-1' })]) {
      const error = await attempt().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(MayuraError);
      expect(error).toMatchObject({ code: 'CONFLICT' });
      expect((error as Error).message).toMatch(/idempotency key was already used .* different input, definition version or runtime settings/);
      expect((error as Error).message).not.toMatch(/version changed/);
    }
    // Sagas report the same condition the same way.
    const saga = defineWorkflowSaga({ id: 'errors.saga', version: '1', input: any, output: any,
      steps: [{ id: 'one', forward: definition, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'one', path: [] } });
    const sagas = createWorkflowSagaRuntime({ store: fixture.store, scope, permissions: { allow: ['tool:errors/echo'] }, policyVersion: '1', maxCostMicros: 0 });
    await sagas.submit(saga, { input: 'a', idempotencyKey: 'saga-1' });
    await expect(sagas.submit(saga, { input: 'b', idempotencyKey: 'saga-1' })).rejects.toMatchObject({ code: 'CONFLICT',
      message: expect.stringMatching(/idempotency key was already used/) });
  });

  it('keeps an uninitialized or closed store precise instead of reporting unavailable storage', async () => {
    fixture = await sqliteFixture();
    const uninitialized = await runtime(fixture.store).submit(definition, { input: 'a', idempotencyKey: 'x' }).catch((error: unknown) => error);
    expect(uninitialized).toBeInstanceOf(MayuraError);
    expect(uninitialized).toBeInstanceOf(StorageError);
    expect(uninitialized).toMatchObject({ code: 'INVALID_CONFIG', storageCode: 'STORE_NOT_INITIALIZED', message: expect.stringMatching(/initialize\(\)/) });
    await fixture.store.initialize(); await fixture.store.close();
    await expect(runtime(fixture.store).inspect('a'.repeat(64))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', storageCode: 'STORE_CLOSED',
      message: expect.stringMatching(/closed; open a new store/) });
  });
});
