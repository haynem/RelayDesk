import {randomUUID,randomInt,createHash} from 'node:crypto';
import type {Account,Adapter,Batch,Message,Thread,SendContent,Attachment,OutgoingFile} from '../model.js';

import type {ApprovedMessageAction} from '../message-actions.js';
import {downloadPrivateAttachment} from '../attachment-download.js';
// Read-query wire formats cross-checked against Aerogram (MIT); see THIRD_PARTY_NOTICES.md.
export const READ_QUERIES={
  PolarisDirectInboxQuery:'27909866362025854',
  IGDThreadDetailQuery:'29432273173041378',
  IGDMessageListOffMsysQuery:'29380270148264352',
  IGDThreadListOffMsysPaginationQuery:'28774058922187457',
} as const;
// Action wire formats: mautrix-meta v0.2610.0, AGPL-3.0-or-later; see notices.
const WRITE_QUERIES={IGDirectReactionSendMutation:'24374451552236906',IGDirectEditMessageMutation:'32480262318254796',IGDMessageUnsendDialogOffMsysMutation:'26948700068153789',IGDirectTextSendMutation:'26911679871773184',IGDirectMediaSendMutation:'25766288509716264',useIGDMarkThreadAsReadMutation:'27399783383056109'} as const;
type Query=keyof typeof READ_QUERIES;type Mutation=keyof typeof WRITE_QUERIES;
type Tokens={dtsg:string;lsd:string;hs:string;revision:string;branch:string;time:string;at:number};
export function parsePageTokens(html:string):Tokens{
  const grab=(re:RegExp)=>html.match(re)?.[1]||'';
  const tokens={dtsg:grab(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/),lsd:grab(/"LSD",\[\],\{"token":"([^"]+)"/),hs:grab(/"haste_session":"([^"]+)"/),revision:grab(/"__spin_r":(\d+)/),branch:grab(/"__spin_b":"([^"]+)"/)||'trunk',time:grab(/"__spin_t":(\d+)/),at:Date.now()};
  if(!tokens.dtsg||!tokens.lsd)throw Error('Instagram page_tokens_missing');return tokens;
}
export interface ReadClient{reset?(id:string):void;query(a:Account,name:Query,variables:Record<string,unknown>):Promise<any>;mutate?(a:Account,name:Mutation,variables:Record<string,unknown>):Promise<any>;upload?(a:Account,file:OutgoingFile):Promise<string>}
export class InstagramGraphqlClient implements ReadClient{
  private cache=new Map<string,Tokens>();private blockedUntil=new Map<string,number>();private requestId=0;
  constructor(private userAgent:string,private request:typeof fetch=fetch){}
  reset(id:string){for(const name of this.cache.keys())if(name.startsWith(id+':'))this.cache.delete(name);this.blockedUntil.delete(id);}
  private sessionKey(a:Account){const session=(JSON.parse(a.config.cookies||'[]') as any[]).find(c=>c.name==='sessionid')?.value||'';return a.id+':'+createHash('sha256').update(a.config.viewerId+'|'+session).digest('hex');}
  private cookies(a:Account){const list=JSON.parse(a.config.cookies||'[]') as any[];if(list.find(c=>c.name==='ds_user_id')?.value!==a.config.viewerId)throw Error('Instagram identity_mismatch');return list;}
  private headers(a:Account){const cookies=this.cookies(a);return{Cookie:cookies.map(c=>`${c.name}=${c.value}`).join('; '), 'User-Agent':this.userAgent,'Accept-Language':'ja,en;q=0.9'};}
  private absorb(a:Account,res:Response){const cookies=this.cookies(a);for(const header of res.headers.getSetCookie?.()||[]){const pair=header.split(';')[0],at=pair.indexOf('=');if(at<1)continue;const name=pair.slice(0,at),value=pair.slice(at+1);const existing=cookies.find(c=>c.name===name);if(existing)existing.value=value;else cookies.push({name,value,domain:'.instagram.com',path:'/',secure:true});}a.config.cookies=JSON.stringify(cookies);}
  private check(a:Account,res:Response){if(res.status===429||res.status===560){this.blockedUntil.set(a.id,Date.now()+15*60000);throw Error('Instagram rate_limited');}if(!res.ok)throw Error(`Instagram HTTP ${res.status}`);}
  async query(a:Account,name:Query,variables:Record<string,unknown>):Promise<any>{
    if(!Object.hasOwn(READ_QUERIES,name))throw Error('Instagram read_path_denied');
    return this.execute(a,name,READ_QUERIES[name],variables);
  }
  async mutate(a:Account,name:Mutation,variables:Record<string,unknown>){if(!Object.hasOwn(WRITE_QUERIES,name))throw Error('Instagram mutation_denied');return this.execute(a,name,WRITE_QUERIES[name],variables);}
  private async execute(a:Account,name:string,docId:string,variables:Record<string,unknown>):Promise<any>{
    if((this.blockedUntil.get(a.id)||0)>Date.now())throw Error('Instagram rate_limited');
    let tokens=this.cache.get(this.sessionKey(a));
    if(!tokens||Date.now()-tokens.at>10*60000){
      // Fetch HTML only. No scripts execute and no direct-message UI is opened.
      const response=await this.request('https://www.instagram.com/direct/inbox/',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{...this.headers(a),Cookie:this.headers(a).Cookie+'; dpr=2',Accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Upgrade-Insecure-Requests':'1','Sec-Fetch-Site':'none','Sec-Fetch-Mode':'navigate','Sec-Fetch-User':'?1','Sec-Fetch-Dest':'document','sec-ch-ua':'"Chromium";v="143", "Not_A Brand";v="24"','sec-ch-ua-mobile':'?0','sec-ch-ua-platform':'"Windows"'}});
      this.check(a,response);this.absorb(a,response);tokens=parsePageTokens(await response.text());this.cache.set(this.sessionKey(a),tokens);
    }
    const cookies=this.cookies(a),rur=decodeURIComponent(cookies.find(c=>c.name==='rur')?.value||'').split(',')[1];
    const form=new URLSearchParams({av:rur||a.config.viewerId,__d:'www',__user:'0',__a:'1',__req:(++this.requestId).toString(36),__hs:tokens.hs,dpr:'2',__ccg:'MODERATE',__rev:tokens.revision,__comet_req:'7',__spin_r:tokens.revision,__spin_b:tokens.branch,__spin_t:tokens.time,fb_dtsg:tokens.dtsg,jazoest:'2'+[...tokens.dtsg].reduce((sum,c)=>sum+c.codePointAt(0)!,0),lsd:tokens.lsd,server_timestamps:'true',fb_api_caller_class:'RelayModern',fb_api_req_friendly_name:name,doc_id:docId,variables:JSON.stringify(variables)});
    const response=await this.request('https://www.instagram.com/api/graphql',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{...this.headers(a),Accept:'*/*','Content-Type':'application/x-www-form-urlencoded','x-ig-app-id':'936619743392459','X-FB-LSD':tokens.lsd,'X-FB-Friendly-Name':name,'X-ASBD-ID':'359341','X-IG-Max-Touch-Points':'0','Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty',Origin:'https://www.instagram.com',Referer:'https://www.instagram.com/direct/inbox/'},body:form.toString()});
    this.check(a,response);this.absorb(a,response);let data:any;
    try{const raw=(await response.text()).replace(/^for \(;;\);/,'').trim();data=JSON.parse(raw.split('\n')[0]);}catch{throw Error('Instagram invalid_json');}
    if(data.error){this.cache.delete(this.sessionKey(a));const code=Number(data.error);throw Error(Number.isInteger(code)?`Instagram GraphQL ${code}`:'Instagram graphql_error');}
    if(data.errors?.length)throw Error('Instagram graphql_error');if(!data.data)throw Error('Instagram schema_changed');return data;
  }
  async upload(a:Account,file:OutgoingFile){
    await this.query(a,'PolarisDirectInboxQuery',{device_id_for_iris_subscription:a.config.deviceId||(a.config.deviceId=randomUUID()),__relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider:false,__relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider:true,__relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider:5,__relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider:true});
    const tokens=this.cache.get(this.sessionKey(a))!;const form=new FormData();for(const [k,v] of Object.entries({av:a.config.viewerId,__user:'0',__a:'1',__req:(++this.requestId).toString(36),fb_dtsg:tokens.dtsg,jazoest:'2'+[...tokens.dtsg].reduce((sum,c)=>sum+c.codePointAt(0)!,0),lsd:tokens.lsd,__spin_r:tokens.revision,__spin_b:tokens.branch,__spin_t:tokens.time,upload_id:randomUUID()}))form.append(k,v);
    form.append('farr',new Blob([new Uint8Array(file.data)],{type:file.mime}),file.name);
    const response=await this.request('https://www.instagram.com/ajax/mercury/upload.php',{method:'POST',body:form,redirect:'error',headers:{...this.headers(a),'X-FB-LSD':tokens.lsd,'x-ig-app-id':'936619743392459',Origin:'https://www.instagram.com',Referer:'https://www.instagram.com/direct/inbox/'},signal:AbortSignal.timeout(120000)});this.check(a,response);this.absorb(a,response);
    let result:any;try{result=JSON.parse((await response.text()).replace(/^for \(;;\);/,''));}catch{throw Error('Instagram upload_result_unknown');}const metadata=result.payload?.metadata?.['0'],id=metadata&&(metadata.fbid||metadata.image_id||metadata.video_id||metadata.audio_id||metadata.gif_id||metadata.file_id);if(result.error||!id)throw Error('Instagram upload_result_unknown');return String(id);
  }
}
export function mapSlideThread(raw:any,a:Account){
  const id=String(raw.thread_id||raw.thread_fbid||raw.id||'');if(!id)throw Error('Instagram schema_changed');
  const people=(raw.users||[]).map((u:any)=>({id:String(u.pk||u.igid||u.id||''),name:String(u.full_name||u.username||u.id||'不明')}));
  const messages:Message[]=(raw.slide_messages?.edges||[]).map((e:any)=>e.node).filter((m:any)=>m?.message_id||m?.id).map((m:any)=>{
    const sender=m.sender||{},senderId=String(sender.igid||sender.user_dict?.id||'');const content=m.content||{};const kind=String(content.__typename||'');
    const candidates=[content.image?.uri,content.image?.url,content.image_url,content.video?.url,content.video_url,content.media?.image_versions2?.candidates?.[0]?.url,content.media?.video_versions?.[0]?.url,content.xma_image_url,content.image?.src];const mediaUrl=candidates.find(value=>typeof value==='string'&&value.startsWith('https://'));
    const mime=/video/i.test(kind)?'video/mp4':/audio/i.test(kind)?'audio/mp4':'image/jpeg';
    const attachments=/image|photo|video|audio|media|sticker/i.test(kind)?[{kind:mime,name:kind,url:mediaUrl}]:[];
    return{id:String(m.message_id||m.id),threadId:id,accountId:a.id,sender:senderId===a.config.viewerId?'自分':people.find((p:any)=>p.id===senderId)?.name||sender.user_dict?.full_name||sender.user_dict?.username||'不明',text:String(m.text_body||content.text_body||content.xma_text_body||(attachments.length?'':kind?'（'+kind+'）':'')),ts:Number(m.timestamp_ms)||0,senderId,isMe:senderId===a.config.viewerId,attachments,reactions:(m.reactions||[]).reduce((rows:any[],r:any)=>{if(!r.reaction)return rows;const ownFb=(raw.users||[]).find((u:any)=>String(u.pk||u.igid||u.id)===a.config.viewerId)?.interop_messaging_user_fbid||(String(raw.viewer?.id)===a.config.viewerId?raw.viewer?.interop_messaging_user_fbid:undefined);const prior=rows.find(row=>row.name===r.reaction),mine=!!ownFb&&String(r.sender_fbid)===String(ownFb);if(prior){prior.count++;if(mine)prior.mine=true;}else rows.push({name:String(r.reaction),count:1,mine});return rows;},[]),replyTo:m.replied_to_message?.message_id||m.reply_to_message_id};
  });
  const peers=people.filter((p:any)=>p.id!==a.config.viewerId).map((p:any)=>p.name);
  return{thread:{id,accountId:a.id,title:String(raw.thread_title||peers.join('、')||'Instagramの会話'),sourceUnread:typeof raw.unread_count==='number'?raw.unread_count>0:typeof raw.is_unread==='boolean'?raw.is_unread:undefined,sourceUnreadCount:typeof raw.unread_count==='number'?raw.unread_count:undefined,isGroup:!!raw.is_group||peers.length>1,updatedAt:Number(raw.last_activity_timestamp_ms)||Math.max(0,...messages.map(m=>m.ts)),members:people.map((p:any)=>p.id===a.config.viewerId?'自分':p.name),membersComplete:false,memberRecords:people,remoteRef:raw.thread_fbid?String(raw.thread_fbid):undefined,remoteKey:raw.thread_key?String(raw.thread_key):undefined,historyCursor:raw.slide_messages?.page_info?.end_cursor,historyComplete:raw.slide_messages?.page_info?.has_next_page===false},messages};
}
export class InstagramGraphqlAdapter implements Adapter{
  features={files:true,quote:true,receipts:true,edit:true,delete:true,reactions:true,members:true};
  forget(id:string){this.client.reset?.(id);}
  constructor(private client:ReadClient){}
  validateSend(_a:Account,t:Thread,intent:{files:{mime:string}[]}){if(!t.remoteRef)throw Error('先にInstagramの会話を同期してください');if(intent.files.some(f=>!/^image\/|^video\/|^audio\//.test(f.mime)))throw Error('Instagramでは画像・動画・音声だけを送信できます');}
  async sendContent(a:Account,t:Thread,content:SendContent,operationId:string){
    if(!this.client.mutate||!t.remoteRef)throw Error('Instagramの宛先を同期してから再度お試しください');if(content.files.length&&!this.client.upload)throw Error('添付送信を利用できません');
    if(content.files.some(f=>!/^image\/|^video\/|^audio\//.test(f.mime)))throw Error('Instagramでは画像・動画・音声だけを送信できます');
    let last='';const offline=()=>((BigInt(Date.now())<<22n)|BigInt(randomInt(4194304))).toString();
    if(content.text){const result=await this.client.mutate(a,'IGDirectTextSendMutation',{text:{sensitive_string_value:content.text},ig_thread_igid:t.remoteRef,recipient_igids:null,offline_threading_id:offline(),send_attribution:'igd_web_chat_tab:in_thread',mentions:[],mentioned_user_ids:[],commands:null,sampled:null,replied_to_item_id:null,reply_to_message_id:content.replyTo||null,replied_to_client_context:null,forwarded_from_thread_id:null,is_forwarded_from_own_message:null});last=confirmedSend(result);}
    for(const file of content.files){const attachment=await this.client.upload!(a,file),result=await this.client.mutate(a,'IGDirectMediaSendMutation',{attachment_fbid:attachment,offline_threading_id:offline(),thread_id:t.remoteRef,reply_to_message_id:content.replyTo||null,forwarded_from_thread_id:null,is_forwarded_from_own_message:null});last=confirmedSend(result);}if(!last)throw Error('Instagram send_result_unknown');return{id:last||operationId};
  }
  private async freshThread(a:Account,t:Thread){
    if(!t.remoteKey)throw Object.assign(Error('Instagramの会話を再同期してください'),{definitelyNotSent:true});
    const result=await this.client.query(a,'IGDThreadDetailQuery',{min_uq_seq_id:null,thread_fbid:t.remoteKey,__relay_internal__pv__IGDEnableOffMsysChatThemesQErelayprovider:false,__relay_internal__pv__IGDInitialMessagePageCountrelayprovider:100}),raw=result.data?.get_slide_thread_nullable?.as_ig_direct_thread;
    if(!raw||String(raw.thread_id)!==t.id||String(raw.thread_fbid)!==t.remoteRef)throw Object.assign(Error('Instagramの会話の所有関係を確認できません'),{definitelyNotSent:true});return raw;
  }
  async loadMembers(a:Account,t:Thread){const raw=await this.freshThread(a,t);if(!Array.isArray(raw.users))throw Error('参加者の名簿を取得できません');return raw.users.map((u:any)=>({id:String(u.pk||u.igid||u.id),name:String(u.full_name||u.username||u.id)}));}
  async performAction(a:Account,t:Thread,action:ApprovedMessageAction){
    if(!this.client.mutate)throw Object.assign(Error('Instagramの操作経路がありません'),{definitelyNotSent:true});
    const raw=await this.freshThread(a,t);let connection=raw.slide_messages,found:any;
    for(let page=0;page<20;page++){
      found=(connection?.edges||[]).map((e:any)=>e.node).find((m:any)=>m.message_id===action.messageId);if(found)break;
      const cursor=connection?.page_info?.end_cursor;if(!cursor||connection.page_info.has_next_page===false)break;
      const result=await this.client.query(a,'IGDMessageListOffMsysQuery',{after:cursor,before:null,first:100,last:null,id:t.remoteRef,newer_than_message_id:null,older_than_message_id:null,__relay_internal__pv__IGDInitialMessagePageCountrelayprovider:100}),next=result.data?.fetch__SlideThread?.as_ig_direct_thread?.slide_messages;if(!next||next.page_info?.end_cursor===cursor)break;connection=next;
    }
    if(!found)throw Object.assign(Error('対象のメッセージを再取得できません。操作は送っていません'),{definitelyNotSent:true});
    const message=mapSlideThread({...raw,slide_messages:{edges:[{node:found}]}},a).messages[0];
    if(!message||message.id!==action.messageId||message.text!==action.expectedText||(action.kind==='edit'||action.kind==='delete')&&!message.isMe)throw Object.assign(Error('対象の本文または所有者が変更されています'),{definitelyNotSent:true});
    if(action.kind==='edit'){
      if(!action.text?.trim()||action.text.length>10000)throw Object.assign(Error('編集後の本文を確認してください'),{definitelyNotSent:true});
      const result=await this.client.mutate(a,'IGDirectEditMessageMutation',{thread_id:t.remoteRef,target_item_id:'',body:{sensitive_string_value:action.text},offline_threading_id:((BigInt(Date.now())<<22n)|BigInt(randomInt(4194304))).toString(),target_message_id:action.messageId});if(result.data?.direct_edit_message_with_slide_messaging_response?.message_id!==action.messageId)throw Error('Instagram edit_result_unknown');return;
    }
    if(action.kind==='delete'){const result=await this.client.mutate(a,'IGDMessageUnsendDialogOffMsysMutation',{message_id:action.messageId,send_data:{thread_id:t.id}});if(result.data?.direct_unsend_message!==true)throw Error('Instagram unsend_result_unknown');return;}
    const result=await this.client.mutate(a,'IGDirectReactionSendMutation',{input:{emoji:action.emoji,item_id:'',message_id:action.messageId,reaction_status:action.kind==='react-add'?'created':'deleted',thread_id:t.remoteRef}}),response=result.data?.xig_direct_reaction_send_with_slide_messaging_response;
    if(!response?.id||!Array.isArray(response.reactions))throw Error('Instagram reaction_result_unknown');
  }
  async markRead(a:Account,t:Thread,message:Message){if(!this.client.mutate)throw Error('既読更新を利用できません');await this.client.mutate(a,'useIGDMarkThreadAsReadMutation',{data:{item_id:'',message_id:message.id},metadata:{ig_thread_igid:t.id}});}
  async downloadAttachment(a:Account,file:Attachment){return downloadPrivateAttachment(a,file,['cdninstagram.com','fbcdn.net'],[]);}
  async loadThread(a:Account,t:Thread):Promise<Batch>{
    if(!t.historyCursor){if(!t.remoteKey)throw Error('会話の識別情報を再同期してください');const result=await this.client.query(a,'IGDThreadDetailQuery',{min_uq_seq_id:null,thread_fbid:t.remoteKey,__relay_internal__pv__IGDEnableOffMsysChatThemesQErelayprovider:false,__relay_internal__pv__IGDInitialMessagePageCountrelayprovider:30}),raw=result.data?.get_slide_thread_nullable?.as_ig_direct_thread;if(!raw)throw Error('Instagram schema_changed');const mapped=mapSlideThread({...raw,thread_id:t.id,thread_key:t.remoteKey,thread_fbid:t.remoteRef||raw.thread_fbid},a);t.historyCursor=mapped.thread.historyCursor;t.historyComplete=mapped.thread.historyComplete;return{threads:[mapped.thread],messages:mapped.messages};}
    if(t.historyComplete)return{threads:[],messages:[]};if(!t.remoteRef)throw Error('先に会話を同期してください');
    const response=await this.client.query(a,'IGDMessageListOffMsysQuery',{after:t.historyCursor,before:null,first:100,last:null,id:t.remoteRef,newer_than_message_id:null,older_than_message_id:null,__relay_internal__pv__IGDInitialMessagePageCountrelayprovider:100}),connection=response.data?.fetch__SlideThread?.as_ig_direct_thread?.slide_messages;
    if(!connection)throw Error('Instagram schema_changed');const mapped=mapSlideThread({thread_id:t.id,thread_fbid:t.remoteRef,thread_key:t.remoteKey,thread_title:t.title,users:(t.memberRecords||[]).map(p=>({id:p.id,full_name:p.name})),slide_messages:connection},a);
    t.historyCursor=connection.page_info?.end_cursor||t.historyCursor;t.historyComplete=connection.page_info?.has_next_page===false;return{threads:[],messages:mapped.messages};
  }
  async sync(a:Account):Promise<Batch>{
    const inbox=await this.client.query(a,'PolarisDirectInboxQuery',{device_id_for_iris_subscription:a.config.deviceId||(a.config.deviceId=randomUUID()),__relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider:false,__relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider:true,__relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider:5,__relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider:true});
    const mailbox=inbox.data?.get_slide_mailbox_for_iris_subscription;if(!mailbox?.threads_by_folder)throw Error('Instagram schema_changed');
    const batch:Batch={threads:[],messages:[]};
    for(const edge of (mailbox.threads_by_folder.edges||[]).slice(0,15)){
      const initial=edge.node?.as_ig_direct_thread;if(!initial)continue;
      const detail=await this.client.query(a,'IGDThreadDetailQuery',{min_uq_seq_id:null,thread_fbid:String(initial.thread_key),__relay_internal__pv__IGDEnableOffMsysChatThemesQErelayprovider:false,__relay_internal__pv__IGDInitialMessagePageCountrelayprovider:30});
      const raw=detail.data?.get_slide_thread_nullable?.as_ig_direct_thread;if(!raw)throw Error('Instagram schema_changed');
      const mapped=mapSlideThread({...initial,...raw},a);batch.threads.push(mapped.thread);batch.messages.push(...mapped.messages);
    }
    let cursor=a.config.igListCursor||mailbox.threads_by_folder.page_info?.end_cursor||'',pages=0;const seen=new Set(batch.threads.map(t=>t.id));
    while(cursor&&pages++<3){
      try{const response=await this.client.query(a,'IGDThreadListOffMsysPaginationQuery',{id:String(mailbox.id),cursor,count:50,folder:'INBOX'}),connection=response.data?.fetch__SlideMailbox?.threads_by_folder;if(!connection)throw Error('Instagram schema_changed');for(const edge of connection.edges||[]){const raw=edge.node?.as_ig_direct_thread;if(!raw)continue;const mapped=mapSlideThread(raw,a);if(seen.has(mapped.thread.id))continue;seen.add(mapped.thread.id);batch.threads.push({...mapped.thread,bodyUnavailable:!mapped.messages.length});batch.messages.push(...mapped.messages);}const next=connection.page_info?.has_next_page===false?'':connection.page_info?.end_cursor||'';if(next===cursor)break;cursor=next;}
      catch{batch.warning='直近の会話を取得しましたが、会話一覧の追加取得には未完了の範囲があります。';batch.warningCode='partial_fetch';break;}
    }
    a.config.igListCursor=cursor;if(cursor){batch.warning=batch.warning||'以前の会話一覧を段階的に追加しています。本文は会話画面から取得できます。';batch.warningCode='partial_fetch';}return batch;
  }
}

// A successful HTTP response alone does not prove a send. Require a provider message identifier.
function confirmedSend(result:any):string{
  const walk=(value:any,depth=0):string=>{if(depth>8||!value||typeof value!=='object')return'';if(typeof value.message_id==='string'&&value.message_id)return value.message_id;if(typeof value.item_id==='string'&&value.item_id)return value.item_id;for(const item of Object.values(value)){const found=walk(item,depth+1);if(found)return found;}return'';};
  const id=walk(result.data);if(!id)throw Error('Instagram send_result_unknown');return id;
}
