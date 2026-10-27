import type {State} from './model.js';
/** Explicit allowlist: never include IDs, names, credentials, titles or message bodies. */
export function diagnosticSummary(state:State){
  return {accounts:state.accounts.length,threads:state.threads.length,messages:state.messages.length,
    connections:state.accounts.map(a=>({service:a.service,lastSync:a.lastSync||null,error:!!a.error,errorCode:a.errorCode||null,
      threads:state.threads.filter(t=>t.accountId===a.id).length,messages:state.messages.filter(m=>m.accountId===a.id).length,namedSenders:state.messages.filter(m=>m.accountId===a.id&&!m.isMe&&!!m.senderId&&m.sender!==m.senderId&&m.sender!=='不明').length,unavailable:state.messages.filter(m=>m.accountId===a.id&&m.unavailable).length,unreadKnown:state.threads.filter(t=>t.accountId===a.id&&t.sourceUnread!==undefined).length,sourceUnread:state.threads.filter(t=>t.accountId===a.id&&t.sourceUnread===true).length})),
    aiShared:state.accounts.filter(a=>a.aiAllowed).length};
}
