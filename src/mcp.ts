import {randomUUID} from 'node:crypto';
import type {State} from './model.js';
import {buildAttentionQueue} from './attention.js';
export function sharedThread(state:State,accountId:string,threadId:string){
  const account=state.accounts.find(a=>a.id===accountId);
  return !!account?.aiAllowed&&(account.aiScope!=='selected'||!!account.aiThreadIds?.includes(threadId));
}
export function mcp(state:State, request:any):any {
  if(!request||typeof request!=='object'||Array.isArray(request))return{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}};
  const {id,method,params={}}=request;
  if(id===undefined)return null;
  const result=(result:any)=>({jsonrpc:'2.0',id,result});
  const error=(message:string)=>({jsonrpc:'2.0',id,error:{code:-32602,message}});
  if(!params||typeof params!=='object'||Array.isArray(params))return error('Invalid parameters');
  if(method==='initialize')return result({protocolVersion:['2025-03-26','2025-06-18','2025-11-25'].includes(params.protocolVersion)?params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'relaydesk-private',version:'0.3.0'}});
  if(method==='ping')return result({});
  const tool=(name:string,description:string,properties:object={},required:string[]=[],write=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:!write,destructiveHint:false,openWorldHint:false}});
  const names=[tool('list_accounts','共有を許可したアカウント一覧'),tool('list_threads','ローカルに保存済みの会話一覧',{accountId:{type:'string'}}),tool('get_messages','保存済み本文。最終同期以降の新着は含まない',{accountId:{type:'string'},threadId:{type:'string'}},['accountId','threadId']),tool('list_members','保存済みの参加者。完全な名簿を取得できたかを併記',{accountId:{type:'string'},threadId:{type:'string'}},['accountId','threadId']),tool('search','許可済みアカウントの保存済み本文を横断検索',{query:{type:'string'}},['query'])];
  const paging={offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:200}},range={since:{type:'number',description:'Unix time in milliseconds; inclusive'},until:{type:'number',description:'Unix time in milliseconds; exclusive'}};
  names.push(tool('page_threads','共有会話を最新順にページ取得。続きはnextOffsetを指定',{accountId:{type:'string'},...paging}),tool('page_messages','保存済み本文を新しい順にページ取得。全履歴は端末の取得範囲内',{accountId:{type:'string'},threadId:{type:'string'},...range,...paging},['accountId','threadId']),tool('page_search','共有済みの本文を横断検索してページ取得',{query:{type:'string'},accountId:{type:'string'},...range,...paging},['query']));
  names.push(tool('list_attention','共有を許可した要確認の連絡を推定優先度順に取得。元サービスの未読状態が不明な項目は区別する',{accountId:{type:'string'}}));
  if(state.draftAllowed)names.push(tool('stage_reply','承認待ち返信案を端末内に保存。送信しない',{accountId:{type:'string'},threadId:{type:'string'},text:{type:'string'}},['accountId','threadId','text'],true));
  if(method==='tools/list')return result({tools:names});
  if(method!=='tools/call')return {jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}};
  const {name,arguments:a={}}=params;
  if(!a||typeof a!=='object'||Array.isArray(a))return error('Invalid arguments');
  if(!names.some(t=>t.name===name))return error('Tool is not allowed');
  const allowed=new Set(state.accounts.filter(a=>a.aiAllowed).map(a=>a.id));
  const wrap=(value:any)=>result({content:[{type:'text',text:JSON.stringify(value)}]});
  if(name.startsWith('page_')){
    const offset=a.offset??0,limit=a.limit??100;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200||[a.since,a.until].some(v=>v!==undefined&&(!Number.isFinite(v)||v<0)))return error('Invalid page range');
    const page=(items:any[])=>({items:items.slice(offset,offset+limit),total:items.length,nextOffset:offset+limit<items.length?offset+limit:null,scope:'saved_local_cache'});
    if(name==='page_threads')return wrap(page(state.threads.filter(t=>sharedThread(state,t.accountId,t.id)&&(!a.accountId||t.accountId===a.accountId)).sort((x,y)=>y.updatedAt-x.updatedAt||x.id.localeCompare(y.id))));
    if(name==='page_messages'&&(!sharedThread(state,a.accountId,a.threadId)||!state.threads.some(t=>t.accountId===a.accountId&&t.id===a.threadId)))return error('Thread is not shared');
    if(name==='page_search'&&(typeof a.query!=='string'||!a.query.trim()||a.query.length>300))return error('query required');
    const items=state.messages.filter(m=>!m.deleted&&sharedThread(state,m.accountId,m.threadId)&&(!a.accountId||m.accountId===a.accountId)&&(name!=='page_messages'||m.threadId===a.threadId)&&(a.since===undefined||m.ts>=a.since)&&(a.until===undefined||m.ts<a.until)&&(name!=='page_search'||m.text.toLowerCase().includes(a.query.toLowerCase()))).sort((x,y)=>y.ts-x.ts||x.id.localeCompare(y.id));
    return wrap({...page(items.map(publicMessage)),lastSync:name==='page_messages'?state.accounts.find(account=>account.id===a.accountId)?.lastSync||null:undefined});
  }
  if(name==='list_accounts')return wrap(state.accounts.filter(a=>allowed.has(a.id)).map(({id,name,service,lastSync})=>({id,name,service,lastSync:lastSync||null})));
  if(name==='list_threads')return wrap(state.threads.filter(t=>sharedThread(state,t.accountId,t.id)&&(!a.accountId||a.accountId===t.accountId)).sort((x,y)=>y.updatedAt-x.updatedAt).slice(0,100));
  if(name==='list_attention')return wrap(buildAttentionQueue(state).filter(i=>i.pending&&sharedThread(state,i.accountId,i.threadId)&&(!a.accountId||a.accountId===i.accountId)).slice(0,100));
  if(name==='search'){if(typeof a.query!=='string'||!a.query.trim()||a.query.length>300)return error('query required');return wrap(state.messages.filter(m=>!m.deleted&&sharedThread(state,m.accountId,m.threadId)&&m.text.toLowerCase().includes(a.query.toLowerCase())).sort((x,y)=>x.ts-y.ts).slice(-100).map(publicMessage));}
  if(!allowed.has(a.accountId))return error('Account is not shared');
  if(!sharedThread(state,a.accountId,a.threadId))return error('Thread is not shared');
  const thread=state.threads.find(t=>t.accountId===a.accountId&&t.id===a.threadId);if(!thread)return error('Thread not found');
  if(name==='get_messages')return wrap({lastSync:state.accounts.find(x=>x.id===a.accountId)?.lastSync||null,messages:state.messages.filter(m=>m.accountId===a.accountId&&m.threadId===a.threadId&&!m.deleted).sort((x,y)=>x.ts-y.ts).slice(-100).map(publicMessage)});
  if(name==='list_members')return wrap({members:thread.memberRecords||thread.members,complete:thread.membersComplete,note:thread.membersComplete?'取得時点の名簿':'保存された発言者のみ。全参加者ではありません。'});
  if(name==='stage_reply'){if(typeof a.text!=='string'||!a.text.trim()||a.text.length>10000)return error('Invalid draft');const draft={id:randomUUID(),accountId:a.accountId,threadId:a.threadId,text:a.text,createdAt:Date.now(),status:'pending' as const};state.drafts.push(draft);return wrap({id:draft.id,status:'pending',sent:false});}
  return error('Unknown tool');
}

function publicMessage(message:import('./model.js').Message){const {mailUid,mailValidity,historyCursor,...visible}=message;return{...visible,attachments:message.attachments.map(({name,kind,size})=>({name,kind,size}))};}
