import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(new URL('../src/lib/capture.ts', import.meta.url), 'utf8');
const compiled = stripTypeScriptTypes(source);
const {createCapture} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function environment({deny=false, late=false}={}) {
 let contexts=0, tracks=0, intervals=new Set(), current, resolvePermission;
 const originals = {AudioContext:globalThis.AudioContext, MediaRecorder:globalThis.MediaRecorder, navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'), setInterval,clearInterval};
 class Track { constructor(){ tracks++; this.stopped=false; } stop(){if(!this.stopped){tracks--;this.stopped=true;}} }
 const newStream=()=>{const track=new Track();return {getTracks:()=>[track],getAudioTracks:()=>[track]};};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>deny?Promise.reject(new Error('Permission denied')):late?new Promise(r=>{resolvePermission=()=>r(newStream());}):Promise.resolve(newStream())}}});
 globalThis.AudioContext=class { constructor(){contexts++;this.state='running';} resume(){return Promise.resolve();} close(){assert.notEqual(this.state,'closed','context closed twice');this.state='closed';contexts--;return Promise.resolve();} createAnalyser(){return {fftSize:2048,disconnect(){},getFloatTimeDomainData(a){a.fill(0);}};} createMediaStreamSource(){return {connect(){},disconnect(){}};} };
 globalThis.MediaRecorder=class { static isTypeSupported(){return true;} constructor(){this.state='inactive';this.mimeType='audio/webm';current=this;} start(){this.state='recording';} stop(){assert.equal(this.state,'recording');this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['audio'])});this.onstop?.();});} };
 globalThis.setInterval=callback=>{intervals.add(callback);return callback;};
 globalThis.clearInterval=callback=>intervals.delete(callback);
 return { counts:()=>[contexts,tracks,intervals.size], recorder:()=>current, resolve:()=>resolvePermission(), restore(){globalThis.AudioContext=originals.AudioContext;globalThis.MediaRecorder=originals.MediaRecorder;Object.defineProperty(globalThis,'navigator',originals.navigator);globalThis.setInterval=originals.setInterval;globalThis.clearInterval=originals.clearInterval;} };
}
const options=signal=>({automatic:false,signal,onPhase(){},onMeter(){},onComplete(){},onError(){}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('ten recordings stop, deliver audio, and release all resources',async()=>{
 const env=environment();try{let complete=0;
 for(let i=0;i<10;i++){const controller=new AbortController();const session=await createCapture({...options(controller.signal),onComplete(blob){assert.ok(blob.size);complete++;}});assert.deepEqual(env.counts(),[1,1,1]);session.stop();session.stop();await flush();session.cancel();controller.abort();assert.deepEqual(env.counts(),[0,0,0]);}
 assert.equal(complete,10);
 }finally{env.restore();}
});
test('cancel does not analyze and is safe twice',async()=>{const env=environment();try{const c=new AbortController();const s=await createCapture({...options(c.signal),onComplete(){assert.fail('cancel submitted audio');}});c.abort();s.cancel();await flush();assert.deepEqual(env.counts(),[0,0,0]);}finally{env.restore();}});
test('recorder failure releases resources and permits another take',async()=>{const env=environment();try{let errors=0;const c=new AbortController();await createCapture({...options(c.signal),onError(){errors++;}});env.recorder().onerror();await flush();assert.equal(errors,1);assert.deepEqual(env.counts(),[0,0,0]);const s=await createCapture(options(new AbortController().signal));s.stop();await flush();assert.deepEqual(env.counts(),[0,0,0]);}finally{env.restore();}});
test('permission denial releases audio context',async()=>{const env=environment({deny:true});try{await assert.rejects(createCapture(options(new AbortController().signal)),/Permission denied/);assert.deepEqual(env.counts(),[0,0,0]);}finally{env.restore();}});
test('permission resolved after cancellation releases the late microphone',async()=>{const env=environment({late:true});try{const c=new AbortController();const pending=createCapture(options(c.signal));await flush();c.abort();env.resolve();await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(env.counts(),[0,0,0]);}finally{env.restore();}});
