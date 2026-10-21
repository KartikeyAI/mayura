// Opt-in SDK harness, deliberately not executed during development. Install @ag-ui/client and @ag-ui/core separately.
import { HttpAgent } from '@ag-ui/client';
import { EventSchemas } from '@ag-ui/core';
const url=process.env.MAYURA_AG_UI_URL; const token=process.env.MAYURA_AG_UI_TOKEN;
if (!url || !token) throw new Error('Explicit demo endpoint/token required. Use fixture credentials only.');
const endpoint=new URL(url); if (!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)) throw new Error('Conformance harness accepts loopback fixtures only.');
const agent=new HttpAgent({ url,headers:{ Authorization:`Bearer ${token}` },threadId:crypto.randomUUID(),initialMessages:[{ id:crypto.randomUUID(),role:'user',content:'SDK conformance fixture' }] });
await agent.runAgent({ runId:crypto.randomUUID() },{ onEvent:({ event }) => { EventSchemas.parse(event); } });
console.log('Reference client consumed the fixture stream. Approval/frontend continuation cases require the demo flow.');
