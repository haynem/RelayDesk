import test from 'node:test';import assert from 'node:assert/strict';
import {buildAttentionQueue,rankAttention} from '../dist/attention.js';
import {mergeBatch} from '../dist/model.js';
const now=1800000000000;
const thread=(accountId,id,extra={})=>({accountId,id,title:'fixture',members:[],membersComplete:false,...extra});
const msg=(accountId,threadId,id,text,extra={})=>({accountId,threadId,id,text,isMe:false,ts:now-1000,attachments:[],...extra});
test('attention distinguishes verified service unread from unknown and local confirmation without receipts',()=>{
  const s={threads:[thread('a','read',{sourceUnread:false}),thread('a','unread',{sourceUnread:true}),thread('a','unknown'),thread('a','replied')],messages:[msg('a','read','1','read fixture'),msg('a','unread','2','unread fixture'),msg('a','unknown','3','unknown fixture'),msg('a','replied','4','old fixture'),msg('a','replied','5','my reply',{isMe:true,ts:now})],drafts:[]};
  const items=buildAttentionQueue(s,now);assert.equal(items.find(i=>i.threadId==='read').pending,false);assert.equal(items.find(i=>i.threadId==='unread').pending,true);assert.equal(items.find(i=>i.threadId==='unknown').sourceUnread,undefined);assert.equal(items.find(i=>i.threadId==='unknown').pending,true);assert.equal(items.find(i=>i.threadId==='replied').pending,false);
  s.threads[1].localSeenAt=now-1000;s.threads[1].localSeenMessageId='2';const seen=buildAttentionQueue(s,now).find(i=>i.threadId==='unread');assert.equal(seen.sourceUnread,true);assert.equal(seen.locallySeen,true);assert.equal(seen.pending,false);
  s.messages.push(msg('a','unread','new','new at same timestamp'));assert.equal(buildAttentionQueue(s,now).find(i=>i.threadId==='unread').pending,true);
});
test('priority feedback changes ranking, survives sync, and never leaks between matching IDs on different accounts',()=>{
  const s={threads:[thread('a','same',{priorityFeedback:-2}),thread('b','same',{priorityFeedback:2})],messages:[msg('a','same','1','fixture'),msg('b','same','1','fixture')],drafts:[]};
  assert.equal(buildAttentionQueue(s,now)[0].accountId,'b');
  mergeBatch(s,{id:'a'},{threads:[thread('a','same')],messages:[]});assert.equal(s.threads.find(t=>t.accountId==='a').priorityFeedback,-2);assert.equal(s.threads.find(t=>t.accountId==='b').priorityFeedback,2);
  assert.ok(rankAttention(thread('a','t'),msg('a','t','1','本日までに返信をお願いします'),now).score>rankAttention(thread('a','t'),msg('a','t','1','通常の連絡'),now).score);
  assert.ok(!rankAttention(thread('a','t'),msg('a','t','1','認証コード 123456 至急'),now).reasons.includes('期限・緊急の表現'));
});
test('manual adjustment moves a whole priority level, including saturated high scores',()=>{
  const urgent=msg('a','t','m','今日の至急のお願い。返信してください？');
  assert.equal(rankAttention(thread('a','t',{priority:2}),urgent,now).level,'high');
  assert.equal(rankAttention(thread('a','t',{priority:2,priorityFeedback:-1}),urgent,now).level,'medium');
  assert.equal(rankAttention(thread('a','t',{priority:2,priorityFeedback:-2}),urgent,now).level,'low');
  const bulk=msg('a','t','m','キャンペーンのご案内。配信停止はこちら');
  assert.equal(rankAttention(thread('a','t'),bulk,now).level,'low');assert.equal(rankAttention(thread('a','t',{priorityFeedback:1}),bulk,now).level,'medium');
  assert.equal(rankAttention(thread('a','t',{priorityFeedback:2}),bulk,now).level,'high');
  assert.ok(!rankAttention(thread('a','t'),{...urgent,unavailable:true},now).reasons.includes('期限・緊急の表現'));
});
test('thread-only encrypted notices do not fabricate message records or source-unread claims',()=>{
  const s={threads:[thread('a','encrypted',{updatedAt:now,bodyUnavailable:true})],messages:[],drafts:[]};const items=buildAttentionQueue(s,now);
  assert.equal(items.length,1);assert.equal(items[0].bodyUnavailable,true);assert.equal(items[0].messageId,null);assert.equal(items[0].sourceUnread,undefined);assert.equal(items[0].pending,true);assert.equal(s.messages.length,0);
});
