import { createAgUiFrontendExecutor } from 'mayura/ag-ui';
const element=id => document.getElementById(id); const config=await fetch('/session',{ cache:'no-store' }).then(response => response.json());
const threadId=sessionStorage.getItem('mayura-demo-thread') || crypto.randomUUID(); sessionStorage.setItem('mayura-demo-thread',threadId);
let uncertain=false; const proposals=new Map(); let busy=false; let interrupt; let pendingCall; let retained; let nativeId; const messages=new Map();
const executor=createAgUiFrontendExecutor({ publicOrigin:location.origin,token:() => config.token,
  permissions:{ allow:['ag-ui:frontend-execute','frontend:ui.choose'] },handlers:{ 'ui.choose':async input => ({ selected:input.theme }) } });
function show(message) { let node=messages.get(message.id); if (!node) { node=document.createElement('p'); messages.set(message.id,node); element('messages').append(node); } node.textContent=typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? message.toolCalls ?? ''); }
async function history() { const response=await fetch(`/v1/threads/${encodeURIComponent(threadId)}/entries`,{ headers:{ authorization:`Bearer ${config.token}` } }); if (response.ok) element('history').textContent=JSON.stringify((await response.json()).entries,null,2); }
async function run(extra) {
  if (busy) return; busy=true; element('send').disabled=true; element('approval').hidden=true; element('recover').hidden=true;
  const runId=retained?.runId || crypto.randomUUID(); const body={ threadId,runId,tools:config.tools,...extra }; let finished;
  try {
    const response=await fetch('/ag-ui',{ method:'POST',headers:{ authorization:`Bearer ${config.token}`,'content-type':'application/json' },body:JSON.stringify(body) });
    if (!response.ok) throw new Error(); nativeId=response.headers.get('x-mayura-run-id') || nativeId;
    const reader=response.body.getReader(); const decoder=new TextDecoder('utf-8',{ fatal:true }); let buffer=''; let total=0;
    async function event(event) {
      if (event.type === 'MESSAGES_SNAPSHOT') { messages.clear(); element('messages').replaceChildren(); event.messages.forEach(show); }
      if (event.type === 'TEXT_MESSAGE_START') show({ id:event.messageId,content:'' });
      if (event.type === 'TEXT_MESSAGE_CONTENT') { const node=messages.get(event.messageId); if (node) node.textContent+=event.delta; }
      if (event.type === 'STATE_SNAPSHOT') element('state').textContent=JSON.stringify(event.snapshot,null,2);
      if (event.type === 'TOOL_CALL_START') proposals.set(event.toolCallId,{ name:event.toolCallName,args:'' });
      if (event.type === 'TOOL_CALL_ARGS') { const proposal=proposals.get(event.toolCallId); if (!proposal || proposal.args.length+event.delta.length>65536) throw new Error(); proposal.args+=event.delta; }
      if (event.type === 'TOOL_CALL_START' && event.metadata?.mayura?.frontend) pendingCall=event;
      if (event.type === 'RUN_ERROR') throw new Error();
      if (event.type === 'RUN_FINISHED') finished=event.outcome;
    }
    try { for (;;) { const next=await reader.read(); if (next.done) { buffer+=decoder.decode(); break; } total+=next.value.length; if (total>8388608) throw new Error(); buffer+=decoder.decode(next.value,{ stream:true }); let end; while ((end=buffer.indexOf('\n\n'))>=0) { const frame=buffer.slice(0,end); buffer=buffer.slice(end+2); if (frame.startsWith('data: ')) await event(JSON.parse(frame.slice(6))); } } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (buffer.trim() || !finished) throw new Error(); retained=undefined;
    if (finished.type === 'interrupt') { interrupt=finished.interrupts[0]; const proposal=proposals.get(interrupt.toolCallId); if (!proposal) throw new Error(); element('proposal').textContent=`${proposal.name}\n${JSON.stringify(JSON.parse(proposal.args),null,2)}\nExpires: ${interrupt.expiresAt}`; element('approval').hidden=false; element('status').textContent='Waiting for your decision.'; }
    else if (finished.pendingToolCallIds?.length) {
      if (!pendingCall) throw new Error(); const call=pendingCall; pendingCall=undefined;
      const result=await executor.execute(call); retained={ ...result,runId:crypto.randomUUID() }; element('recover').hidden=false;
      element('status').textContent='Browser result saved locally. Deliver it to continue; the browser action will not run again.';
    } else element('status').textContent='Finished.';
    await history();
  } catch { uncertain=true; element('status').textContent='Delivery was not confirmed. Inspect the native run before starting another action.'; if (retained) element('recover').hidden=false; }
  finally { busy=false; element('send').disabled=uncertain || Boolean(retained) || Boolean(interrupt); }
}
element('composer').addEventListener('submit',event => { event.preventDefault(); if (retained || interrupt || uncertain) return; void run({ messages:[{ id:crypto.randomUUID(),role:'user',content:element('text').value }] }); });
for (const [id,approved] of [['approve',true],['reject',false]]) element(id).addEventListener('click',() => { if (!interrupt || busy) return; const target=interrupt; interrupt=undefined; void run({ messages:[],resume:[{ interruptId:target.id,status:'resolved',payload:{ approved } }] }); });
element('recover').addEventListener('click',() => { if (retained) void run({ messages:[retained.message],forwardedProps:retained.forwardedProps }); });
window.addEventListener('beforeunload',event => { if (retained) { event.preventDefault(); event.returnValue=''; } });
element('inspect').addEventListener('click',() => { if (!nativeId || busy) return;
  void fetch(`/v1/runs/${encodeURIComponent(nativeId)}`,{ headers:{ authorization:`Bearer ${config.token}` } }).then(async response => {
    if (!response.ok) throw new Error(); const value=await response.json(); element('run').textContent=`Status: ${value.status}\nSpent: ${value.budget.spentMicros} µ`;
    if (!['running','waiting'].includes(value.status)) { uncertain=false; interrupt=undefined; retained=undefined; element('recover').hidden=true;element('approval').hidden=true;element('send').disabled=false; await history(); }
  }).catch(() => { element('status').textContent='Inspection is unavailable. No action was replayed.'; });
});
element('cancel').addEventListener('click',() => { if (!nativeId || busy) return; uncertain=true;element('send').disabled=true;
  void fetch(`/v1/runs/${encodeURIComponent(nativeId)}/cancel`,{ method:'POST',headers:{ authorization:`Bearer ${config.token}` } }).then(response => { element('status').textContent=response.ok ? 'Cancellation requested. Inspect the run for its outcome.' : 'Cancellation was not confirmed. Inspect the run.'; }).catch(() => { element('status').textContent='Cancellation was not confirmed. Inspect the run.'; });
});
