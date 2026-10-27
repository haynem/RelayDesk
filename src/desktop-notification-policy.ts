import {buildAttentionQueue} from './attention.js';
import {key,type State,type Account,type Batch} from './model.js';
import {localRule} from './learning.js';
export type NotificationTarget={accountId:string;threadId:string;messageId:string;level:'low'|'medium'|'high'};
/** Only new incoming messages after a successful baseline; never toast historical backfill. */
export function newNotificationTargets(state:State,account:Account,batch:Batch,known:Set<string>,since:number|undefined,now=Date.now()):NotificationTarget[]{
  if(!since||state.desktopNotifications?.enabled===false)return[];
  const minimum=state.desktopNotifications?.minimum||'all',fresh=new Set(batch.messages.filter(m=>!m.isMe&&!m.deleted&&!m.unavailable&&Number.isFinite(m.ts)&&m.ts>=since&&m.ts>=now-86400000&&m.ts<=now+300000&&!known.has(key(m.accountId,m.threadId,m.id))).map(m=>key(m.accountId,m.threadId,m.id)));
  return buildAttentionQueue(state,now).map(i=>({...i,level:localRule(state,i.accountId,i.threadId)?.mode==='quiet'?'low' as const:i.level})).filter(i=>i.accountId===account.id&&i.pending&&i.messageId!==null&&fresh.has(key(i.accountId,i.threadId,i.messageId))&&(minimum!=='high'||i.level==='high')&&(minimum!=='medium'||i.level!=='low')).map(i=>({accountId:i.accountId,threadId:i.threadId,messageId:i.messageId!,level:i.level}));
}
