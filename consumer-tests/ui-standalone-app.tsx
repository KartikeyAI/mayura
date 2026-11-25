import { AgentWorkspace, Composer, UiRoot } from '@mayurajs/ui';
import { useAgUiConversation, type AgUiEvent, type AgUiRunInput, type AgUiTransport } from '@mayurajs/ui/ag-ui';

export const reply = 'Streamed by a plain React app.';
export const prompt = 'Hello, standalone UI';
export const workspacePrompt = 'Ask the workspace';
export const tableValue = 'Available';
export const requests: AgUiRunInput[] = [];

const transport = {
  async run(input, signal) {
    signal.throwIfAborted();
    requests.push(input);
    const { runId, threadId } = input;
    const events: AgUiEvent[] = [
      { type: 'RUN_STARTED', runId, threadId, metadata: { mayura: { runId } } },
      { type: 'TEXT_MESSAGE_START', messageId: 'reply-1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply-1', delta: 'Streamed by ' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply-1', delta: 'a plain React app.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'reply-1' },
      { type: 'STATE_SNAPSHOT', metadata: { mayura: { stateRevision: 1 } }, snapshot: {
        replyCards: [{
          id: 'service-status', type: 'table', title: 'Service status',
          data: { columns: ['Service', 'Status'], rows: [['UI', tableValue]] },
        }],
      } },
      { type: 'RUN_FINISHED', runId, threadId, outcome: { type: 'success' } },
    ];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  },
} satisfies AgUiTransport;

export function App() {
  const chat = useAgUiConversation({ transport });
  return (
    <>
      <UiRoot theme="dark">
        <h1>Plain React chat</h1>
        <Composer onSend={chat.send} onStop={chat.stop} streaming={chat.status === 'streaming'} disabled={false} />
        <button type="button" onClick={() => chat.send(prompt)}>Send sample message</button>
        <output aria-label="Run status">{chat.status}</output>
        {chat.messages.map(message => <p key={message.id}>{message.content}</p>)}
      </UiRoot>
      <AgentWorkspace title="Standalone Agent Workspace" transport={transport} suggestions={[workspacePrompt]} />
    </>
  );
}
