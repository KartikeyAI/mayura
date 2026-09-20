import { defineAgent, createRuntime, type Schema } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { listenAgentServer, type LocalAgentServer } from '@mayura/server-node';
import { createClient, type RemoteOutcome } from '@mayura/client';
import { createObserver, type Observer, type ObservedRun, type ObserverSnapshot } from '@mayura/observability';

const number: Schema<number> = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value } : { issues: [] } } };
const agent = defineAgent({ id: 'consumer.agent', version: '1', instructions: 'Consume public declarations.', tools: [], input: number, output: number,
  model: scriptedModel([{ type: 'final', output: 4, usage: { costMicros: 0 } }]),
});
const permissions = { allow: ['model:scripted'] };
const runtime = createRuntime({ profile: 'ephemeral', permissions });
const handle = runtime.submit(agent, { input: 2 });
const observer: Observer = createObserver();
const observation = observer.observe(handle);
const reason: string = (await observation.done()).reason;
const summary: ObservedRun | undefined = observer.inspect(handle.id);
const snapshot: ObserverSnapshot = observer.inspect();
if (summary) {
  const events: number | string = summary.counters.events;
  // @ts-expect-error Observed counters preserve exact count representation.
  const invalid: boolean = summary.counters.events;
  // @ts-expect-error Observation snapshots cannot be mutated.
  summary.recent.push({});
  void events; void invalid;
}
void reason; void snapshot;
const server: LocalAgentServer = await listenAgentServer({ agents: [{ agent, permissions }], authenticate: async () => null });
const client = createClient({ baseUrl: server.origin, token: () => 'compile-only-fixture' });
const remote = client.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const result: RemoteOutcome<number> | undefined = await remote.result(number);
if (result?.status === 'succeeded') {
  const output: number = result.output;
  // @ts-expect-error Validated result remains a number.
  const invalid: string = result.output;
  void output; void invalid;
}
if (false) {
  // @ts-expect-error The local host cannot bind public interfaces through its typed API.
  await listenAgentServer({ agents: [{ agent, permissions }], authenticate: async () => null, hostname: '0.0.0.0' });
  // @ts-expect-error Explicit token verification is mandatory.
  await listenAgentServer({ agents: [{ agent, permissions }] });
  // @ts-expect-error Observation does not expose run cancellation.
  observation.cancel();
}
await observer.close(); await runtime.close(); await server.close();
