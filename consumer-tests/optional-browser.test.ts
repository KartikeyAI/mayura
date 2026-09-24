import { createClient, type ClientSchema, type RemoteOutcome } from '@mayura/client';
import { createHeadlessRunStore, createHumanRequestView, createRunActivityProjection } from '@mayura/client/headless';

const output: ClientSchema<{ answer: number }> = {
  '~standard': { version: 1, validate: value => typeof value === 'number' ? { value: { answer: value } } : { issues: [] } },
};

/** Executed from a browser-target bundle with Web globals only; the supplied Fetch is a local fixture. */
export async function verifyBrowserClient(transport: typeof fetch): Promise<number> {
  const client = createClient({ baseUrl: 'https://consumer.invalid', token: () => 'bundler-fixture', fetch: transport });
  const agents = await client.agents();
  const view = createHumanRequestView(Object.freeze({ id: 'review', agentId: 'agent', kind: 'information' as const, schemaId: 'answer-v1',
    schemaDigest: 'a'.repeat(64), prompt: 'Provide evidence.', digest: 'b'.repeat(64), status: 'waiting' as const }), 1_000);
  if (!view.canRespond || view.actionText !== 'Provide information') throw new Error('Headless human view failed.');
  const store = createHeadlessRunStore({ run: client.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') });
  if (store.getSnapshot().connection !== 'idle' || createRunActivityProjection(store.getSnapshot()).items.length !== 0) throw new Error('Headless run store performed implicit work.'); store.dispose();
  return agents.length;
}

/** Compile-only assertions preserve output inference and reject accidental Node ambient dependencies. */
export async function verifyBrowserTypes(transport: typeof fetch): Promise<void> {
  const client = createClient({ baseUrl: 'https://consumer.invalid', token: () => 'type-fixture', fetch: transport });
  const store = createHeadlessRunStore({ run: client.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') });
  const unsubscribe: () => void = store.subscribe(() => {}); unsubscribe(); store.dispose();
  const outcome: RemoteOutcome<{ answer: number }> | undefined = await client.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').result(output);
  if (outcome?.status === 'succeeded') {
    const answer: number = outcome.output.answer;
    // @ts-expect-error Output remains schema-derived, not any.
    const invalid: string = outcome.output.answer;
    void answer; void invalid;
  } else if (outcome) {
    // @ts-expect-error Non-success cannot disclose an output field.
    void outcome.output;
  }
  if (false) {
    // @ts-expect-error Browser consumers do not acquire Node globals from Mayura declarations.
    void process;
    // @ts-expect-error Browser consumers do not acquire Node Buffer types.
    void Buffer;
  }
}
