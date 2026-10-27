import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {randomBytes} from 'node:crypto';
import {Vault} from '../dist/vault.js';import {startServer} from '../dist/server.js';
test('attention actions are local, native screens require acknowledgement, new mail is staged before approval',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-attention-'));const vault=new Vault(dir,randomBytes(32));
  vault.state.accounts=[{id:'a',adapter:'imap',service:'email',name:'Fixture mail',config:{smtpHost:'smtp.example.test'},aiAllowed:false}];
  vault.state.threads=[{id:'t',accountId:'a',title:'Fixture',members:[],membersComplete:false,updatedAt:100,sourceUnread:true}];vault.state.messages=[{id:'m',accountId:'a',threadId:'t',text:'Fixture',isMe:false,ts:100,attachments:[]}];
  let syncs=0,sends=0,opens=0;const backend=await startServer(vault,resolve('ui'),{imap:{sync:async()=>{syncs++;return{threads:[],messages:[]};},sendText:async()=>{sends++;return{id:'fake'};}}},{openService:async()=>{opens++;}});
  const api=async(path,data)=>{const r=await fetch(`http://127.0.0.1:${backend.port}/api/`+path,{method:data?'POST':'GET',headers:{'X-Relay-Session':backend.session,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return{status:r.status,body:await r.json()};};
  try{
    assert.equal((await api('state')).body.attention[0].pending,true);
    await api('attention-feedback',{accountId:'a',threadId:'t',direction:1});assert.equal(vault.state.threads[0].priorityFeedback,1);
    assert.equal((await api('state')).body.attention[0].level,'high');
    await api('attention-feedback',{accountId:'a',threadId:'t',direction:1,expectedLevel:'high'});assert.equal(vault.state.threads[0].priorityFeedback,1);
    await api('attention-feedback',{accountId:'a',threadId:'t',direction:-1,expectedLevel:'high'});assert.equal((await api('state')).body.attention[0].level,'medium');
    await api('attention-feedback',{accountId:'a',threadId:'t',direction:-1,expectedLevel:'medium'});assert.equal((await api('state')).body.attention[0].level,'low');
    assert.equal((await api('attention-feedback',{accountId:'a',threadId:'t',direction:1,expectedLevel:'medium'})).status,400);
    assert.equal((await api('attention-feedback',{accountId:'other',threadId:'t',direction:1})).status,400);
    await api('attention-seen',{accountId:'a',threadId:'t',messageId:'m'});assert.equal((await api('state')).body.attention[0].pending,false);assert.equal(vault.state.threads[0].sourceUnread,true);assert.equal(syncs,0);assert.equal(sends,0);
    assert.equal((await api('open-service',{service:'email',accountId:'a'})).status,400);assert.equal(opens,0);
    assert.equal((await api('open-service',{service:'email',accountId:'a',acknowledgeReadEffects:true})).status,200);assert.equal(opens,1);
    assert.equal((await api('open-service',{service:'slack',accountId:'a',acknowledgeReadEffects:true})).status,400);
    const result=await api('new-email-draft',{accountId:'a',recipient:'recipient@example.test',subject:'Synthetic new subject',text:'Synthetic body'});assert.equal(result.status,200);assert.equal(result.body.sent,false);assert.equal(sends,0);
    const thread=vault.state.threads.find(t=>t.id===result.body.threadId);assert.equal(thread.composeMode,'new');
    const prepared=await api('prepare-send',{draftId:result.body.id});assert.equal(prepared.body.preview.subject,'Synthetic new subject');thread.title='Changed subject';assert.equal((await api('approve-send',{draftId:result.body.id,challenge:prepared.body.challenge,explicitConfirmation:true})).status,400);assert.equal(sends,0);
    assert.equal((await api('new-email-draft',{accountId:'a',recipient:'recipient@example.test\r\nBcc:other@example.test',subject:'Synthetic',text:'Synthetic'})).status,400);
    vault.state.accounts[0].config.user='self@example.test';const selfTest=await api('self-email-test',{accountId:'a'}),again=await api('self-email-test',{accountId:'a'});assert.equal(selfTest.status,200);assert.equal(selfTest.body.id,again.body.id);assert.equal(sends,0);const selfPreview=await api('prepare-send',{draftId:selfTest.body.id});assert.equal(selfPreview.body.preview.recipient,'self@example.test');assert.equal(selfPreview.body.preview.text,'RelayDesk PC版の送信テストです。');
    await api('update-draft',{draftId:selfTest.body.id,text:'Changed synthetic text'});assert.equal((await api('approve-send',{draftId:selfTest.body.id,challenge:selfPreview.body.challenge,explicitConfirmation:true})).status,400);assert.equal(sends,0);
    const updated=await api('prepare-send',{draftId:selfTest.body.id});await api('discard-draft',{draftId:selfTest.body.id});assert.equal((await api('approve-send',{draftId:selfTest.body.id,challenge:updated.body.challenge,explicitConfirmation:true})).status,400);assert.equal(sends,0);
  }finally{await backend.close();rmSync(dir,{recursive:true});}
});
