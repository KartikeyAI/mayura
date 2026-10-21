import { useState } from 'react';
import registry from '../../../packages/cli/ui/registry.json';
import { ToolCall } from '../../../packages/cli/ui/tool-call';
import { Citations } from '../../../packages/cli/ui/citations';
import { BrowserView } from '../../../packages/cli/ui/browser-view';
import { SandboxTerminal } from '../../../packages/cli/ui/sandbox-terminal';
import { Voice } from '../../../packages/cli/ui/voice';
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
  return <div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]"><nav aria-label="Component previews" className="flex flex-wrap gap-2 lg:flex-col">{registry.components.map(component => <button key={component.id} aria-pressed={selected === component.id} className="border border-line px-3 py-2 text-left" onClick={() => { setSelected(component.id);setCopied(false); }}>{component.id}</button>)}</nav>
    <div className="min-w-0 space-y-6"><h2 className="text-2xl font-semibold">{selected}</h2><p>Source {item.version} · Mayura {item.minimumMayura}+ · React. Local fixture; no service actions.</p>{preview}{selected === 'voice' ? <p role="status">{voice}</p> : null}
      <pre className="overflow-auto border-y border-line py-4">mayura add ui {selected} --directory ./my-app --apply</pre>
      <details><summary>Component source</summary><button onClick={() => { void navigator.clipboard.writeText(source).then(() => setCopied(true),() => setCopied(false)); }}>{copied ? 'Copied' : 'Copy source'}</button><pre className="max-h-96 overflow-auto whitespace-pre-wrap">{source}</pre></details>
      <details><summary>Shared CSS</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap">{Object.entries(sources).find(([path]) => path.endsWith('/ui.css'))?.[1]}</pre></details>
    </div></div>;
}
