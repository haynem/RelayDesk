import type {Account,Adapter,Batch,Thread,Message,Attachment,SendContent} from '../model.js';
import {downloadPrivateAttachment} from '../attachment-download.js';
import type {ApprovedMessageAction} from '../message-actions.js';
import {DiscordPersonalRpc,DiscordRpcError} from '../discord-rpc.js';
export class DiscordAdapter implements Adapter{
  features={files:true,quote:true,edit:true,delete:true,reactions:true};
  constructor(private endpoint='https://discord.com/api/v10/'){}
  private personal=new DiscordPersonalRpc();
  canPageThread(a:Account){return a.config.mode!=='rpc'&&a.config.mode!=='user';}
  canSendThread(a:Account){return a.config.mode!=='rpc'&&a.config.mode!=='user';}
  private async call(a:Account,path:string,options:RequestInit={}){if(a.config.mode==='rpc')throw new DiscordRpcError('scope_denied');if(a.config.mode==='user')throw Error('Discordの統合取得は公式Bot接続のみ対応しています。個人の会話は元のDiscord画面で操作してください。');const response=await fetch(new URL(path,this.endpoint),{...options,redirect:'error',headers:{Authorization:'Bot '+a.config.token,...(options.body instanceof FormData?{}:{'Content-Type':'application/json'})},signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Discordの認証・権限・取得制限を確認してください');return response.status===204?{}:response.json() as Promise<any>;}
  async sync(a:Account):Promise<Batch>{if(a.config.mode==='rpc')return this.personal.sync(a);const me=await this.call(a,'users/@me');const batch:Batch={threads:[],messages:[]};const channels=await Promise.all(a.config.channels.split(/[\s,]+/).filter(Boolean).map(id=>this.call(a,'channels/'+encodeURIComponent(id))));for(const c of channels.slice(0,50)){const rows=await this.call(a,`channels/${encodeURIComponent(c.id)}/messages?limit=50`);const messages=rows.map((m:any)=>this.message(a,c.id,m,String(me.id)));batch.messages.push(...messages);batch.threads.push({id:c.id,accountId:a.id,title:c.name||(c.recipients||[]).map((u:any)=>u.global_name||u.username).join('、')||'Discordの会話',isGroup:c.type!==1,updatedAt:Math.max(0,...messages.map((m:any)=>m.ts)),members:[...new Set<string>(messages.map((m:any)=>m.sender))],membersComplete:false});}return batch;}
  validateSend(_a:Account,_t:Thread,intent:{text:string}){if(intent.text.length>2000)throw Error('Discordの本文は2000文字までです');}
  async sendText(a:Account,t:Thread,text:string,id:string){return this.sendContent(a,t,{text,files:[]},id);}
  async sendContent(a:Account,t:Thread,content:SendContent,id:string){
    if(content.text.length>2000)throw Error('Discordの本文は2000文字までです');
    const payload={content:content.text,nonce:id.replace(/-/g,'').slice(0,24),enforce_nonce:true,allowed_mentions:{parse:[]},...(content.replyTo?{message_reference:{message_id:content.replyTo,fail_if_not_exists:true}}:{}),attachments:content.files.map((f,index)=>({id:index,filename:f.name}))};
    let body:string|FormData=JSON.stringify(payload);if(content.files.length){const form=new FormData();form.append('payload_json',JSON.stringify(payload));content.files.forEach((f,index)=>form.append('files['+index+']',new Blob([new Uint8Array(f.data)],{type:f.mime}),f.name));body=form;}
    const data=await this.call(a,`channels/${encodeURIComponent(t.id)}/messages`,{method:'POST',body});return{id:String(data.id)};
  }
  private message(a:Account,threadId:string,m:any,viewer:string):Message{return{id:String(m.id),threadId,accountId:a.id,sender:m.author?.id===viewer?'自分':m.author?.global_name||m.author?.username||'不明',senderId:m.author?.id,text:String(m.content||''),ts:Date.parse(m.timestamp)||0,isMe:m.author?.id===viewer,attachments:(m.attachments||[]).map((f:any)=>({name:String(f.filename||'file'),kind:String(f.content_type||'application/octet-stream'),size:f.size,url:f.url,remoteId:f.id})),replyTo:m.message_reference?.message_id,editedAt:m.edited_timestamp?Date.parse(m.edited_timestamp):undefined,reactions:(m.reactions||[]).map((r:any)=>({name:r.emoji?.name+(r.emoji?.id?':'+r.emoji.id:''),count:r.count,mine:!!r.me}))};}
  async loadThread(a:Account,t:Thread,before?:string):Promise<Batch>{if(before&&!/^\d+$/.test(before))throw Error('履歴位置が無効です');const me=await this.call(a,'users/@me'),rows=await this.call(a,`channels/${encodeURIComponent(t.id)}/messages?limit=100${before?'&before='+encodeURIComponent(before):''}`);return{threads:[],messages:rows.map((m:any)=>this.message(a,t.id,m,String(me.id)))};}
  async downloadAttachment(a:Account,file:Attachment){return downloadPrivateAttachment(a,file,['cdn.discordapp.com','media.discordapp.net']);}
  async performAction(a:Account,t:Thread,action:ApprovedMessageAction){
    const me=await this.call(a,'users/@me'),base=`channels/${encodeURIComponent(t.id)}/messages/${encodeURIComponent(action.messageId)}`,message=await this.call(a,base);
    if(String(message.id)!==action.messageId||String(message.channel_id)!==t.id||String(message.content||'')!==action.expectedText)throw Error('対象のメッセージが更新または削除されました');
    if((action.kind==='edit'||action.kind==='delete')&&message.author?.id!==me.id)throw Error('自分のメッセージだけを変更できます');
    if(action.kind==='edit'){if((action.text||'').length>2000)throw Error('Discordの本文は2000文字までです');await this.call(a,base,{method:'PATCH',body:JSON.stringify({content:action.text,allowed_mentions:{parse:[]}})});return;}
    if(action.kind==='delete'){await this.call(a,base,{method:'DELETE'});return;}
    await this.call(a,base+'/reactions/'+encodeURIComponent(action.emoji!)+'/@me',{method:action.kind==='react-add'?'PUT':'DELETE'});
  }
}
