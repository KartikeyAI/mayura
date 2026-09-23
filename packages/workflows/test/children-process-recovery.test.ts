import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowTreeSnapshot } from '../src/children.js';

type Scenario='approval'|'dispatch';
interface Marker {readonly kind:'waiting'|'dispatched'|'completed'|'fixture_error';readonly runId?:string;readonly digest?:string;readonly code?:string;readonly phase?:string;readonly before?:WorkflowTreeSnapshot;readonly snapshot?:WorkflowTreeSnapshot;readonly repeated?:WorkflowTreeSnapshot;readonly events?:readonly {readonly sequence:number;readonly type:string;readonly data:Readonly<Record<string,unknown>>}[]}
const fixturePath=fileURLToPath(new URL('./fixtures/workflow-tree-process-recovery.mjs',import.meta.url));
const tempPrefix='mayura-tree-process-recovery-';

async function within<T>(promise:Promise<T>,label:string,timeoutMs=10_000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${label}.`)),timeoutMs);})]);}finally{if(timer)clearTimeout(timer);}}

class FixtureProcess{
  readonly #child:ChildProcess;readonly #messages:Marker[]=[];readonly #listeners=new Set<()=>void>();readonly #exited:Promise<{code:number|null;signal:NodeJS.Signals|null}>;#exitObserved=false;#failure:Error|undefined;#stderr='';
  constructor(args:readonly string[]){this.#child=fork(fixturePath,[...args],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});this.#child.stderr?.on('data',(chunk:Buffer)=>{this.#stderr=`${this.#stderr}${chunk.toString()}`.slice(-4_096);});this.#child.on('message',(message:Marker)=>{this.#messages.push(message);if(message.kind==='fixture_error')this.#failure=new Error(`Child fixture failed (${message.code??'unknown'}) at ${message.phase??'unknown'}. ${this.#stderr}`);for(const listener of this.#listeners)listener();});this.#exited=new Promise((resolveExit,rejectExit)=>{this.#child.once('error',error=>{this.#failure=error;this.#exitObserved=true;rejectExit(error);for(const listener of this.#listeners)listener();});this.#child.once('exit',(code,signal)=>{this.#exitObserved=true;resolveExit({code,signal});for(const listener of this.#listeners)listener();});});void this.#exited.catch(()=>{});}
  async marker(kind:Marker['kind']):Promise<Marker>{let listener:(()=>void)|undefined;try{return await within(new Promise<Marker>((resolveMarker,reject)=>{listener=()=>{const found=this.#messages.find(message=>message.kind===kind);if(found)resolveMarker(found);else if(this.#failure)reject(this.#failure);else if(this.#exitObserved)reject(new Error(`Child exited before ${kind}. ${this.#stderr}`));};this.#listeners.add(listener);listener();}),`child marker ${kind}`);}finally{if(listener)this.#listeners.delete(listener);}}
  async successfulExit():Promise<void>{expect(await within(this.#exited,'successful child exit')).toEqual({code:0,signal:null});}
  async kill():Promise<void>{const pid=this.#child.pid;if(!this.#exitObserved&&pid!==undefined)process.kill(pid,'SIGKILL');await within(this.#exited,'owned child termination').catch(error=>{if(!this.#failure)throw error;});}
}

describe('real process termination and SQLite workflow-tree recovery',()=>{
  let directory:string;let children:FixtureProcess[];
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),tempPrefix));children=[];});
  afterEach(async()=>{await Promise.all(children.map(child=>child.kill()));const actual=await realpath(directory);const temporaryRoot=await realpath(tmpdir());if(dirname(actual)!==temporaryRoot||!basename(actual).startsWith(tempPrefix)||resolve(directory)!==resolve(actual))throw new Error('Refusing cleanup outside the verified test-owned temporary directory.');await rm(actual,{recursive:true,force:true});});
  const spawn=(scenario:Scenario,action:'start'|'recover',runId?:string,digest?:string)=>{const child=new FixtureProcess([scenario,action,directory,...(runId?[runId]:[]),...(digest?[digest]:[])]);children.push(child);return child;};
  async function effects(){try{const contents=await readFile(join(directory,'effects.ndjson'),'utf8');return contents.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {runId:string;callId:string});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}}

  it('survives termination at root approval and executes the effect once after restart',async()=>{const first=spawn('approval','start');const waiting=await first.marker('waiting');expect(waiting.snapshot?.status).toBe('waiting');expect(waiting.digest).toBeTypeOf('string');expect(await effects()).toEqual([]);await first.kill();const second=spawn('approval','recover',waiting.runId!,waiting.digest!);const completed=await second.marker('completed');await second.successfulExit();const review=completed.before?.steps['write']?.approval as {digest?:unknown}|null;expect(review?.digest).toBe(waiting.digest);expect(completed.snapshot).toMatchObject({status:'succeeded',output:{value:7},steps:{write:{approval:{humanId:'verified-reviewer'},receipt:{execution:'succeeded',disclosure:'released'}}}});expect(completed.repeated).toEqual(completed.snapshot);expect(await effects()).toEqual([{runId:waiting.runId,callId:`${waiting.runId}/step:write`}]);expect(completed.events?.filter(event=>event.type==='step.dispatching')).toHaveLength(1);},25_000);

  it('quarantines a killed in-flight root effect and never redispatches it',async()=>{const first=spawn('dispatch','start');const dispatched=await first.marker('dispatched');expect(await effects()).toHaveLength(1);await first.kill();const second=spawn('dispatch','recover',dispatched.runId!);const completed=await second.marker('completed');await second.successfulExit();expect(completed.before?.steps['write']).toMatchObject({status:'dispatching',receipt:null});expect(completed.snapshot?.status).toBe('outcome_unknown');expect(completed.snapshot?.steps['write']?.status).toBe('unknown');expect(completed.snapshot?.budget.accounts.find(account=>account.id==='root')).toMatchObject({spentMicros:0,reservedMicros:1,calls:1,closed:true});expect(completed.repeated).toEqual(completed.snapshot);expect(await effects()).toHaveLength(1);expect(completed.events?.filter(event=>event.type==='step.dispatching')).toHaveLength(1);},25_000);
});
