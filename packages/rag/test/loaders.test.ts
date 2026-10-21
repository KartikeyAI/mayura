import {describe,expect,it,vi} from 'vitest';
import {loadHtml,loadPdf} from '../src/index.js';
const base={id:'source',reference:'source.pdf',sensitivity:'internal' as const};
describe('inert loader parser boundaries',()=>{
  it('denies parser dispatch without permission and refuses PDF cancellation/failures',async()=>{
    const extract=vi.fn(async()=>['page']);const pdf=new TextEncoder().encode('%PDF-fixture');
    await expect(loadPdf(pdf,{...base,parser:{extract},permissions:{allow:[]},signal:new AbortController().signal,maxPages:1})).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(extract).not.toHaveBeenCalled();
    const control=new AbortController();control.abort();await expect(loadPdf(pdf,{...base,parser:{extract},permissions:{allow:['rag:load:pdf']},signal:control.signal,maxPages:1})).rejects.toMatchObject({code:'CANCELLED'});
    await expect(loadPdf(pdf,{...base,parser:{extract:async()=>{throw new Error('SECRET');}},permissions:{allow:['rag:load:pdf']},signal:new AbortController().signal,maxPages:1})).rejects.not.toThrow('SECRET');
  });
  it('extracts admitted PDF pages and removes active/hidden HTML nodes',async()=>{
    expect((await loadPdf(new TextEncoder().encode('%PDF-fixture'),{...base,parser:{extract:async()=>['first','second']},permissions:{allow:['rag:load:pdf']},signal:new AbortController().signal,maxPages:2})).text).toBe('first\n\nsecond');
    const remove=vi.fn();const parse=vi.fn(()=>({querySelectorAll:()=>[{remove}],body:{textContent:'safe body'}}));
    expect(loadHtml('<body>safe body<script>active</script></body>',{...base,parser:{parse},permissions:{allow:['rag:load:html']}}).text).toBe('safe body');expect(remove).toHaveBeenCalledTimes(1);
  });
});
