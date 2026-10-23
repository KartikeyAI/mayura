import { useState } from 'react';
import registry from '../../../packages/cli/ui/registry.json';
import { ToolCall } from '../../../packages/cli/ui/tool-call';
import { Citations } from '../../../packages/cli/ui/citations';
import { BrowserView } from '../../../packages/cli/ui/browser-view';
import { SandboxTerminal } from '../../../packages/cli/ui/sandbox-terminal';
import { Voice } from '../../../packages/cli/ui/voice';
import './ui-gallery.css';

const labels: Record<string, string> = {
  chat: 'Chat', 'thread-history': 'Thread history', approval: 'Approvals', 'run-status': 'Run status',
  'workflow-progress': 'Workflow progress', 'thread-list': 'Thread list', 'tool-call': 'Tool calls',
  citations: 'Citations', 'browser-view': 'Browser view', 'sandbox-terminal': 'Sandbox terminal', voice: 'Voice',
};
const sources = import.meta.glob('../../../packages/cli/ui/*.{tsx,css}',{ eager:true,query:'?raw',import:'default' }) as Record<string,string>;
/** Public gallery owns no service credentials, timers, run stores or inference. Previews are local fixtures. */
export function UiGallery() {
  const [selected,setSelected]=useState('chat'); const [text,setText]=useState(''); const [reply,setReply]=useState(''); const [decision,setDecision]=useState('Waiting for your review');
  const [thread,setThread]=useState('Notebook'); const [copied,setCopied]=useState(false); const [voice,setVoice]=useState('No recording sent');
  const item=registry.components.find(item => item.id === selected)!;
  const source=Object.entries(sources).find(([path]) => path.endsWith(`/${selected}.tsx`))?.[1] || '';
  const preview = selected === 'tool-call' ? <ToolCall name="notes.save" status="Waiting for approval" input={'{"text":"My note"}'} />
    : selected === 'citations' ? <Citations sources={[{ id:'manual',title:'A released source from your retrieval tool' }]} />
    : selected === 'browser-view' ? <BrowserView allowedOrigin="https://example.invalid" title="Browser screenshot preview" />
    : selected === 'sandbox-terminal' ? <SandboxTerminal status="Finished" output={'$ example task\nCompleted in the isolated sandbox.'} />
    : selected === 'voice' ? <Voice onRecording={async blob => { setVoice(`Recorded ${blob.size} bytes locally; no upload.`); }} />
    : <section className="mayura-ui" aria-label="Local component fixture">
      {selected === 'chat' ? <><h2>Conversation</h2><p>{reply || 'Your next idea starts here.'}</p><form onSubmit={event => { event.preventDefault();setReply(text);setText(''); }}><label>Your message<textarea value={text} onChange={event => setText(event.target.value)} maxLength={2000} /></label><button disabled={!text.trim()}>Send locally</button></form></>
      : selected === 'approval' ? <><h2>Save your note?</h2><pre>{'{"text":"An idea worth keeping"}'}</pre><p role="status">{decision}</p><button onClick={() => setDecision('Approved in this preview only')} disabled={decision !== 'Waiting for your review'}>Approve</button><button onClick={() => setDecision('Rejected in this preview only')} disabled={decision !== 'Waiting for your review'}>Reject</button></>
      : selected === 'thread-list' ? <><h2>Your conversations</h2>{['Notebook','Research','Planning'].map(name => <button key={name} aria-pressed={thread === name} onClick={() => setThread(name)}>{name}</button>)}<p role="status">Selected: {thread}</p></>
      : selected === 'thread-history' ? <><h2>Notebook</h2><ol><li>You: Keep this idea.</li><li>Assistant: Saved after your approval.</li></ol></>
      : selected === 'workflow-progress' ? <><h2>Workflow progress</h2><ol><li>Review — complete</li><li>Approve — waiting</li><li>Save — not started</li></ol></>
      : <><h2>Run status</h2><p>Waiting for approval</p><p>Spent: 0 µ · Limit: 100 µ</p></>}
    </section>;
  return (
    <div className="ui-gallery grid items-start gap-8 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-12">
      <nav aria-label="Component previews" className="flex flex-wrap gap-1 lg:sticky lg:top-24 lg:flex-col">
        {registry.components.map(component => (
          <button type="button" key={component.id} aria-pressed={selected === component.id}
            className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${selected === component.id
              ? 'bg-soft font-medium text-primary' : 'text-muted hover:bg-soft hover:text-fg'}`}
            onClick={() => { setSelected(component.id);setCopied(false); }}>
            {labels[component.id] ?? component.id}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        <h2 className="text-2xl font-semibold tracking-tight">{labels[selected]}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">Source {item.version} · Mayura {item.minimumMayura}+ · React</p>
        <section aria-label={`${labels[selected]} preview`} className="mt-6 overflow-hidden rounded-2xl border border-line bg-raised">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3 text-xs text-muted">
            <span>Preview</span><span className="inline-flex items-center gap-2"><span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />Local fixture · no service actions</span>
          </div>
          <div className="p-4 sm:p-6">{preview}
            {selected === 'voice' && <p role="status" className="mt-3 text-sm text-muted">{voice}</p>}
          </div>
        </section>
        <div className="mt-6 rounded-xl border border-line bg-code p-4 sm:p-5">
          <p className="mb-3 text-xs text-muted">Add to your project</p>
          <pre className="overflow-x-auto font-mono text-xs leading-relaxed sm:text-sm"><code>mayura add ui {selected} --directory ./my-app --apply</code></pre>
        </div>
        <div className="mt-6 divide-y divide-line border-y border-line">
          <details className="py-4">
            <summary className="cursor-pointer text-sm font-medium">Component source</summary>
            <button type="button" className="mt-4 rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-fg"
              onClick={() => { void navigator.clipboard.writeText(source).then(() => setCopied(true),() => setCopied(false)); }}>{copied ? 'Copied' : 'Copy source'}</button>
            <pre className="mt-4 max-h-96 overflow-auto rounded-xl bg-code p-4 font-mono text-xs leading-relaxed"><code>{source}</code></pre>
          </details>
          <details className="py-4">
            <summary className="cursor-pointer text-sm font-medium">Shared CSS</summary>
            <p className="mt-3 text-sm text-muted">The copied source includes its own stylesheet. This gallery adapts it to the site's theme.</p>
            <pre className="mt-4 max-h-80 overflow-auto rounded-xl bg-code p-4 font-mono text-xs leading-relaxed"><code>{Object.entries(sources).find(([path]) => path.endsWith('/ui.css'))?.[1]}</code></pre>
          </details>
        </div>
      </div>
    </div>
  );
}
