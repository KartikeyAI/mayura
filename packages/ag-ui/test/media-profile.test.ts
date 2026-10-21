import { expect, it } from 'vitest';
import { readInput } from '../src/protocol.js';
const text={ id:'u',role:'user',content:'hello' };const source={ type:'file',value:`sha256:${'a'.repeat(64)}`,provider:'mayura',mimeType:'image/png' };
const body=(content:unknown) => ({ threadId:'thread',runId:'run',messages:[{ ...text,content }] });
it('accepts bounded typed opaque handles only under explicit media admission',() => {const input=body([{ type:'text',text:'look' },{ type:'image',source }]);expect(() => readInput(input,65536,100)).toThrow();expect(readInput(input,65536,100,false,false,true).messages).toHaveLength(1);});
it('rejects URL/data fetches, provider impersonation and empty fresh input',() => {for (const changed of [{ ...source,type:'url',value:'https://evil.test' },{ ...source,type:'data',value:'PRIVATE' },{ ...source,provider:'openai' }]) expect(() => readInput(body([{ type:'text',text:'look' },{ type:'image',source:changed }]),65536,100,false,false,true)).toThrow();expect(() => readInput(body([{ type:'image',source }]),65536,100,false,false,true)).toThrow();});
