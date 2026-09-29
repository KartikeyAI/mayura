import { createClient } from 'mayura/client';
import { listenAgentServer } from 'mayura/server-node';

// Authenticated HTTP for your agents, with live events.
const server = await listenAgentServer({
  agents: [{ agent, permissions: { allow: grants } }],
  authenticate: ({ token }) => verifyWithYourIdP(token),
});

// From a browser, a worker or another service:
const client = createClient({
  baseUrl: server.origin, token: () => session.token,
});
const run = await client.submit('weather-assistant', {
  question: 'Do I need an umbrella?',
}, { idempotencyKey: 'question-1' });

for await (const event of run.events()) {
  console.log(event.sequence, event.type);
}
const result = await run.result(Reply);
