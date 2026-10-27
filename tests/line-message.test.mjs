import test from 'node:test';
import assert from 'node:assert/strict';
import {readLineMessage,lineDisplayName,lookupLineName} from '../dist/line-message.js';
import {mergeBatch} from '../dist/model.js';
test('LINE decryption failure is explicit, isolated, and never overwrites previously decoded text',async()=>{
  const raw={id:'fixture-id',from:'fixture-viewer',createdTime:123,contentType:'NONE',chunks:['synthetic-ciphertext']};
  const failed=await readLineMessage(raw,'a','t','fixture-viewer',async()=>{throw Error('synthetic-secret');});
  assert.equal(failed.unavailable,true);assert.equal(failed.isMe,true);assert.ok(!JSON.stringify(failed).includes('synthetic'));
  const good=await readLineMessage(raw,'a','t','fixture-viewer',async()=>({raw,text:'decoded fixture'}));
  assert.equal(good.unavailable,undefined);assert.deepEqual(good.attachments,[]);
  const state={accounts:[],threads:[],messages:[good],drafts:[]};
  mergeBatch(state,{id:'a'},{threads:[],messages:[failed]});assert.equal(state.messages[0].text,'decoded fixture');
});
test('LINE display names use the current contact schema while preserving sender identity',async()=>{
  assert.equal(lineDisplayName({targetProfileDetail:{profileName:'架空の相手'}}),'架空の相手');assert.equal(lineDisplayName({contact:{displayName:'Legacy fixture'}}),'Legacy fixture');assert.equal(lineDisplayName({}),undefined);
  const message=await readLineMessage({id:'m',from:'fixture-person',createdTime:1},'a','t','viewer',async raw=>({raw,text:'fixture'}));assert.equal(message.senderId,'fixture-person');
});
test('LINE name lookup falls back to read-only legacy APIs and remembers the working schema',async()=>{
  const calls=[],client={getUser:async()=>{calls.push('v3');throw Error('not capable');},base:{talk:{getContactsV2:async()=>{calls.push('v2');return{contacts:{peer:{contact:{displayName:'架空の相手'}}}};},getContact:async()=>{calls.push('legacy');return{displayName:'旧形式'};}}}};
  const first=await lookupLineName(client,'peer');assert.equal(first.name,'架空の相手');assert.equal(first.method,'v2');assert.deepEqual(calls,['v3','v2']);calls.length=0;await lookupLineName(client,'peer',first.method);assert.deepEqual(calls,['v2']);assert.equal(lineDisplayName({displayName:'旧形式'}),'旧形式');
});
