import {readLineMessage,lookupLineName,type LineNameMethod} from '../line-message.js';
import {loginWithAuthToken,loginWithQR,TalkMessage,type Client} from '@evex/linejs';
import {MemoryStorage} from '@evex/linejs/storage';
import {randomUUID} from 'node:crypto';
import type {Account,Adapter,Batch,Thread,SendContent} from '../model.js';
import type {Message,Attachment} from '../model.js';
import type {ApprovedMessageAction} from '../message-actions.js';
import {downloadPrivateAttachment} from '../attachment-download.js';
export class LineAdapter implements Adapter{
  features={files:true,quote:true,delete:true,reactions:true,receipts:true,members:true};
  private names=new Map<string,{name:string;at:number}>();
  private nameMethods=new Map<string,LineNameMethod>();
  private async name(a:Account,client:Client,id:string){const key=a.id+':'+id,old=this.names.get(key);if(old&&Date.now()-old.at<(old.name===id?60000:3600000))return old.name;const {name,method}=await lookupLineName(client,id,this.nameMethods.get(a.id));if(method)this.nameMethods.set(a.id,method);this.names.set(key,{name,at:Date.now()});return name;}
  private clients=new Map<string,{client:Client;storage:MemoryStorage}>();
  async login(onQR:(url:string)=>void,onPin:(pin:string)=>void):Promise<Account>{const storage=new MemoryStorage();const client=await loginWithQR({onReceiveQRUrl:onQR,onPincodeRequest:onPin},{device:'DESKTOPWIN',storage});const profile=await client.getMyProfile();const a:Account={id:randomUUID(),service:'line',adapter:'line',name:profile.displayName||'LINE',config:{token:client.authToken,storage:JSON.stringify(storage.getAll()),viewerId:profile.mid},aiAllowed:false};this.clients.set(a.id,{client,storage});return a;}
  private async connection(a:Account){const existing=this.clients.get(a.id);if(existing)return existing;const storage=new MemoryStorage(JSON.parse(a.config.storage||'{}'));const client=await loginWithAuthToken(a.config.token,{device:'DESKTOPWIN',storage});const result={client,storage};this.clients.set(a.id,result);return result;}
  persist(accounts:Account[]){for(const account of accounts){const cached=this.clients.get(account.id);if(cached){account.config.token=cached.client.authToken;account.config.storage=JSON.stringify(cached.storage.getAll());}}}
  async sync(a:Account):Promise<Batch>{try{return await this.syncRead(a);}finally{this.persist([a]);}}
  private async syncRead(a:Account):Promise<Batch>{const {client,storage}=await this.connection(a);const boxes=await client.base.talk.getMessageBoxes({messageBoxListRequest:{messageBoxCountLimit:50}});const batch:Batch={threads:[],messages:[]};let nameBudget=10;for(const box of (boxes.messageBoxes||[]).slice(0,50)){const id=box.id;if(!id)continue;let title=id;try{title=id.startsWith('u')?await this.name(a,client,id):(await client.getChat(id)).name;}catch{}const rawMessages=box.lastDeliveredMessageId?await client.base.talk.getPreviousMessagesV2WithRequest({request:{messageBoxId:id,endMessageId:box.lastDeliveredMessageId,messagesCount:30}}):[];const rows=[];for(const raw of rawMessages)rows.push(await readLineMessage(raw,a.id,id,a.config.viewerId,m=>TalkMessage.fromRawTalk(m,client)));for(const row of rows){if(row.isMe||!row.senderId)continue;const known=this.names.get(a.id+':'+row.senderId);if(known&&Date.now()-known.at<(known.name===row.senderId?60000:3600000))row.sender=known.name;else if(nameBudget>0){nameBudget--;try{row.sender=await this.name(a,client,row.senderId);}catch{}}}batch.messages.push(...rows);batch.threads.push({id,accountId:a.id,title,sourceUnread:Number.isFinite(Number(box.unreadCount))?Number(box.unreadCount)>0:undefined,sourceUnreadCount:Number.isFinite(Number(box.unreadCount))?Math.max(0,Number(box.unreadCount)):undefined,isGroup:!id.startsWith('u'),updatedAt:Math.max(0,...rows.map(m=>m.ts)),members:[...new Set(rows.map(m=>m.sender))],membersComplete:false});}const missing=batch.messages.filter(m=>m.unavailable).length;if(missing)batch.warning=`LINEの会話を取得しましたが、${missing}件は暗号化を解除できませんでした。再ログインは不要です。読めない内容は元のLINEで確認してください。`;a.config.token=client.authToken;a.config.storage=JSON.stringify(storage.getAll());return batch;}
  validateSend(_a:Account,t:Thread,intent:{text:string;replyTo?:string;files:{name:string;mime:string;size:number}[]}){if(intent.files.length&&!/^[uc]/.test(t.id))throw Error('この種類のLINEの会話では添付送信を利用できません');if(intent.files.length&&intent.replyTo&&!intent.text.trim())throw Error('LINEの添付と引用を組み合わせる場合は、引用返信の本文も入力してください');}
  async sendContent(a:Account,t:Thread,content:SendContent,_id:string){
    const {client,storage}=await this.connection(a);let id='';if(content.text){const result=await client.base.talk.sendMessage({to:t.id,text:content.text,e2ee:true,relatedMessageId:content.replyTo});id=String(result.id);}
    for(const file of content.files){const type=file.mime==='image/gif'?'gif':file.mime.startsWith('image/')?'image':file.mime.startsWith('video/')?'video':file.mime.startsWith('audio/')?'audio':'file',result=await client.base.obs.uploadMediaByE2EE({to:t.id,oType:type,data:new Blob([new Uint8Array(file.data)],{type:file.mime}),filename:file.name});if(!result.id)throw Error('LINEの添付送信結果が不明です');id=String(result.id);}
    a.config.storage=JSON.stringify(storage.getAll());if(!id)throw Error('LINEの送信結果が不明です');return{id};
  }
  forget(id:string){this.clients.delete(id);this.nameMethods.delete(id);for(const key of this.names.keys())if(key.startsWith(id+':'))this.names.delete(key);}
  adoptLogin(fromId:string,toId:string){const ready=this.clients.get(fromId);this.forget(toId);this.clients.delete(fromId);if(ready)this.clients.set(toId,ready);}
  async loadThread(a:Account,t:Thread,before?:string):Promise<Batch>{
    const cursor=before?.match(/^(\d+):(\d+)$/);if(!cursor)throw Error('履歴の先頭を指定してください');
    const {client,storage}=await this.connection(a),raw=await client.base.talk.getPreviousMessagesV2WithRequest({request:{messageBoxId:t.id,endMessageId:{deliveredTime:BigInt(cursor[1]),messageId:BigInt(cursor[2])},messagesCount:100}}),messages=[];
    for(const item of raw){const message=await readLineMessage(item,a.id,t.id,a.config.viewerId,m=>TalkMessage.fromRawTalk(m,client));if(message.id===cursor[2])continue;if(message.senderId&&!message.isMe)try{message.sender=await this.name(a,client,message.senderId);}catch{}messages.push(message);}
    a.config.storage=JSON.stringify(storage.getAll());return{threads:[],messages};
  }
  async loadMembers(a:Account,t:Thread){
    const {client}=await this.connection(a);let ids:string[];
    if(t.id.startsWith('u'))ids=[a.config.viewerId,t.id];
    else{const chat=await client.getChat(t.id),extra=chat.raw.extra?.groupExtra;if(!extra?.memberMids)throw Error('この会話の全参加者を取得できません');ids=Object.keys(extra.memberMids);}
    const members=[];for(const id of [...new Set(ids)])members.push({id,name:id===a.config.viewerId?'自分':await this.name(a,client,id)});return members;
  }
  async performAction(a:Account,t:Thread,action:ApprovedMessageAction){
    if(!['delete','react-add','react-remove'].includes(action.kind)||action.kind==='delete'&&!action.isMe)throw Error('LINEの操作が無効です');
    const {client,storage}=await this.connection(a),rows=await client.base.talk.getPreviousMessagesV2WithRequest({request:{messageBoxId:t.id,endMessageId:{deliveredTime:BigInt(action.messageTimestamp+1),messageId:BigInt(action.messageId)},messagesCount:5}}),raw=rows.find(m=>String(m.id)===action.messageId);
    if(!raw||action.kind==='delete'&&raw.from!==a.config.viewerId)throw Error('操作の対象を確認できません');
    const current=await readLineMessage(raw,a.id,t.id,a.config.viewerId,m=>TalkMessage.fromRawTalk(m,client));if(current.unavailable||current.text!==action.expectedText)throw Error('対象の本文が変わっています');
    if(action.kind==='delete')await client.base.talk.unsendMessage({seq:await client.base.getReqseq(),messageId:action.messageId});else{const name=action.kind==='react-remove'?'UNDO':action.emoji||'',allowed=['NICE','LOVE','FUN','AMAZING','SAD','OMG','UNDO'] as const;if(!allowed.includes(name as any))throw Error('LINEのリアクション名を指定してください');await(await TalkMessage.fromRawTalk(raw,client)).react(name as typeof allowed[number]);}a.config.storage=JSON.stringify(storage.getAll());
  }
  async downloadAttachment(a:Account,file:Attachment){
    let ref:{messageId:string;threadId:string;ts:number};try{ref=JSON.parse(file.remoteId||'');}catch{throw Error('LINEの添付を再取得してください');}
    if(!ref||!/^\d+$/.test(ref.messageId)||typeof ref.threadId!=='string'||!Number.isFinite(ref.ts))throw Error('添付の参照が無効です');
    const {client,storage}=await this.connection(a),rows=await client.base.talk.getPreviousMessagesV2WithRequest({request:{messageBoxId:ref.threadId,endMessageId:{deliveredTime:BigInt(ref.ts+1),messageId:BigInt(ref.messageId)},messagesCount:5}}),raw=rows.find(m=>String(m.id)===ref.messageId);
    if(!raw)throw Error('LINEの添付を取得できません');const message=await TalkMessage.fromRawTalk(raw,client);
    const direct=raw.contentMetadata?.DOWNLOAD_URL||(raw.contentType==='STICKER'||raw.contentType===7?message.getStickerURL():undefined);if(direct)return downloadPrivateAttachment(a,{...file,url:direct},['line.me','line-apps.com','line-scdn.net','naver.jp'],[]);
    const blob=await message.getData();if(blob.size>25*1024*1024)throw Error('添付は25MBまでです');a.config.storage=JSON.stringify(storage.getAll());return Buffer.from(await blob.arrayBuffer());
  }
  async markRead(a:Account,t:Thread,message:Message){const {client,storage}=await this.connection(a);await client.base.talk.sendChatChecked({seq:await client.base.getReqseq(),chatMid:t.id,lastMessageId:message.id,sessionId:0});a.config.storage=JSON.stringify(storage.getAll());}
  async sendText(a:Account,t:Thread,text:string,_id:string){const {client,storage}=await this.connection(a);const result=await client.base.talk.sendMessage({to:t.id,text,e2ee:true});a.config.storage=JSON.stringify(storage.getAll());return{id:String(result.id)};}
}
