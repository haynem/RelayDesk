import test from 'node:test';import assert from 'node:assert/strict';
import {MessengerAdapter} from '../dist/adapters/messenger.js';
import {Outbox} from '../dist/outbox.js';
test('Messenger read helper checks ownership and keeps direct reads separate from Matrix send capability',async()=>{
  const account={id:'local',service:'messenger',adapter:'messenger',name:'Fixture',config:{viewerId:'99',cookies:JSON.stringify([{name:'c_user',value:'99'},{name:'xs',value:'fixture-secret'}]),authOnly:'true'}};
  const reader=async(_path,input)=>{assert.equal(input.mode,'read');assert.equal(input.viewerId,'99');assert.equal(input.cookies[1].value,'fixture-secret');return{viewerId:'99',threads:[{id:'9007199254740993',title:'Fixture',updatedAt:100}],messages:[{id:'m',threadId:'9007199254740993',text:'Synthetic body',sender:'Fixture',ts:100,isMe:false}],encryptedWithoutBody:1};};
  const adapter=new MessengerAdapter('fixture-helper',reader);const batch=await adapter.sync(account);assert.equal(batch.messages[0].accountId,'local');assert.equal(batch.messages[0].threadId,'9007199254740993');assert.equal(batch.threads[0].membersComplete,false);assert.ok(batch.warning);assert.ok(!JSON.stringify(batch).includes('fixture-secret'));
  assert.equal(new Outbox({accounts:[account]}, {messenger:adapter},()=>{}).canSend(account.id),false);
  await assert.rejects(new MessengerAdapter('fixture-helper',async()=>({viewerId:'different'})).sync(account),/identity_mismatch/);
});
