import test from 'node:test';
import assert from 'node:assert/strict';
import {newNotificationTargets} from '../dist/desktop-notification-policy.js';
import {key} from '../dist/model.js';
test('desktop notification policy excludes initial history, duplicates, outgoing, read, unavailable and locally confirmed messages',()=>{
  const now=Date.now(),account={id:'a'},messages=['new','known','old','outgoing','read','failed','confirmed'].map((id,index)=>({id,accountId:'a',threadId:id,text:'PRIVATE-BODY',ts:id==='old'?now-10000:now,isMe:id==='outgoing',unavailable:id==='failed',attachments:[]})),state={accounts:[account],threads:messages.map(m=>({accountId:'a',id:m.threadId,title:'PRIVATE-TITLE',updatedAt:now,members:[],sourceUnread:m.id==='read'?false:undefined,...(m.id==='confirmed'?{localSeenAt:now,localSeenMessageId:m.id}:{})})),messages,drafts:[]},batch={messages,threads:state.threads},known=new Set([key('a','known','known')]);
  assert.deepEqual(newNotificationTargets(state,account,batch,known,undefined,now),[]);
  const result=newNotificationTargets(state,account,batch,known,now-1000,now);assert.deepEqual(result.map(x=>x.messageId),['new']);assert(!JSON.stringify(result).includes('PRIVATE'));
  state.desktopNotifications={enabled:false,minimum:'all'};assert.deepEqual(newNotificationTargets(state,account,batch,known,now-1000,now),[]);
  state.desktopNotifications={enabled:true,minimum:'high'};assert.deepEqual(newNotificationTargets(state,account,batch,known,now-1000,now),[]);
  state.threads[0].priorityFeedback=1;assert.equal(newNotificationTargets(state,account,batch,known,now-1000,now).length,1);
});
