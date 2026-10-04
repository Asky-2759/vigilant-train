import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = await readFile(new URL('../src/lib/session.ts', import.meta.url), 'utf8');
const { comparable, addAttempt, previousComparable } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const take = {id:'one',text:'Hello world.',voiceId:'voice-a',score:75,hasReference:true,dimensions:[{key:'sounds',value:75,weight:.4}],flagged:[],createdAt:'2026-10-04'};
test('only same phrase, voice and scoring basis compare', () => {
  assert.ok(comparable(take,{...take,text:' HELLO  world. '}));
  for (const changed of [{text:'Another phrase'},{voiceId:'voice-b'},{hasReference:false},{dimensions:[{key:'sounds',value:75,weight:1}]}]) assert.equal(comparable(take,{...take,...changed}),false);
});
test('retry replaces one take and history stays bounded', () => {
  assert.equal(addAttempt([take],{...take,score:90}).length,1);
  assert.equal(addAttempt([take],{...take,score:90})[0].score,90);
  const history=Array.from({length:20},(_,i)=>({...take,id:String(i)}));
  assert.equal(addAttempt(history,take).length,20);
});
test('comparison skips the same recording and unrelated phrases', () => {
  const older={...take,id:'older',score:60};
  assert.equal(previousComparable([take,{...take,id:'other',text:'different'},older],take),older);
  assert.equal(previousComparable([take],take),undefined);
});
