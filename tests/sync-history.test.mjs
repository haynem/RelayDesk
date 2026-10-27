import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncCoordinator} from '../dist/sync.js';
import {ImapAdapter} from '../dist/adapters/imap.js';
import {mergeBatch} from '../dist/model.js';
test('sync bounds parallel account reads, shares active work, survives failures, and stop prevents late writes',async()=>{
  let current=0,maximum=0,saves=0;const counts=new Map();
  const state={accounts:Array.from({length:7},(_,n)=>({id:String(n),adapter:'test',config:{}})),threads:[],messages:[],drafts:[]};
  const adapter={sync:async account=>{counts.set(account.id,(counts.get(account.id)||0)+1);current++;maximum=Math.max(maximum,current);await new Promise(resolve=>setTimeout(resolve,10));current--;if(account.id==='2')throw Error('PRIVATE REMOTE ERROR');return{threads:[],messages:[]};}};
  const coordinator=new SyncCoordinator(state,{test:adapter},()=>saves++),first=coordinator.sync();assert.equal(coordinator.sync(),first);await first;assert.equal(maximum,3);assert.equal(counts.size,7);assert([...counts.values()].every(n=>n===1));assert.equal(state.accounts[2].errorCode,'connection_failed');assert(!JSON.stringify(state).includes('PRIVATE'));assert(!coordinator.syncing);
  let release;const later={accounts:[{id:'late',adapter:'test',config:{}}],threads:[],messages:[],drafts:[]},stopped=new SyncCoordinator(later,{test:{sync:async()=>{await new Promise(resolve=>release=resolve);return{threads:[{accountId:'late',id:'t'}],messages:[]};}}},()=>saves++),pending=stopped.sync(),before=saves;stopped.stop();release();await pending;assert.equal(later.threads.length,0);assert.equal(saves,before);
});
test('IMAP older pages use read-only UID search, resume a cursor, and reject a changed UID validity',async()=>{
  const calls=[],account={id:'a',config:{user:'reader@example.test',imapHistoryValidity:'7',imapBeforeUid:'301',imapHistoryComplete:'false'}};
  const fake={connect:async()=>{},mailboxOpen:async(_name,options)=>{assert.equal(options.readOnly,true);return{exists:500,uidValidity:7n};},search:async(query,options)=>{calls.push(query.uid);assert.equal(options.uid,true);return Array.from({length:300},(_,n)=>n+1);},fetch:async function*(range,_query,options){assert.equal(options.uid,true);assert.equal(range.split(',').length,200);assert.equal(range.split(',')[0],'101');for(const uid of [101,300])yield{uid,flags:new Set(),source:Buffer.from(`From: sender@example.test\r\nMessage-ID: <${uid}@example.test>\r\nDate: Tue, 27 Oct 2026 00:00:00 +0000\r\nSubject: Fixture\r\nContent-Type: text/plain\r\n\r\nSynthetic older content`)};},logout:async()=>{},close:()=>{}};
  const adapter=new ImapAdapter(()=>fake),batch=await adapter.loadHistory(account);assert.equal(batch.messages.length,2);assert.deepEqual(calls,['1:300']);assert.equal(account.config.imapBeforeUid,'101');assert.equal(account.config.imapHistoryComplete,'false');
  await assert.rejects(adapter.loadHistory({...account,config:{...account.config,imapHistoryValidity:'6'}}),/先に最新/);
});
test('merging older mail preserves latest metadata and combines unread state over retained messages',()=>{
  const account={id:'a',adapter:'imap'},state={threads:[{accountId:'a',id:'t',title:'new',updatedAt:200,replyAddress:'latest@example.test',replyMessageId:'new',members:['New'],pinned:true,priorityFeedback:1}],messages:[{accountId:'a',threadId:'t',id:'new',ts:200,text:'New',sourceUnread:false}],drafts:[]};
  mergeBatch(state,account,{threads:[{accountId:'a',id:'t',title:'old',updatedAt:100,replyAddress:'old@example.test',members:['Old']}],messages:[{accountId:'a',threadId:'t',id:'old',ts:100,text:'Old',sourceUnread:true}]});
  assert.equal(state.threads[0].updatedAt,200);assert.equal(state.threads[0].replyAddress,'latest@example.test');assert.equal(state.threads[0].title,'new');assert.equal(state.threads[0].priorityFeedback,1);assert.equal(state.threads[0].sourceUnread,true);assert.equal(state.threads[0].sourceUnreadCount,1);assert.deepEqual(state.threads[0].members,['New','Old']);
});
