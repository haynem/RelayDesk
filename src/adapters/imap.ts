import {ImapFlow} from 'imapflow';
import {simpleParser} from 'mailparser';
import {createHash} from 'node:crypto';
import {createTransport} from 'nodemailer';
import type {Account, Adapter, Batch, Thread,SendContent,Attachment} from '../model.js';
import {mailAuth,mailAccessToken} from '../mail-oauth.js';
import {assetId} from '../assets.js';
export class ImapAdapter implements Adapter {
  features={files:true,quote:true,receipts:true};
  constructor(private createClient=(options:ConstructorParameters<typeof ImapFlow>[0])=>new ImapFlow(options),private transport=createTransport){}
  folders(a:Account):string[]{try{const rows=JSON.parse(a.config.mailFolders||'[]');return Array.isArray(rows)&&rows.length&&rows.length<=10&&rows.every(f=>typeof f==='string'&&f.length>0&&f.length<1000)?rows:['INBOX'];}catch{return['INBOX'];}}
  private history(a:Account):Record<string,{validity?:string;before?:string;highest?:number;complete?:boolean}>{try{return JSON.parse(a.config.mailFolderHistory||'{}');}catch{return{};}}
  async listFolders(a:Account){const client=this.createClient({host:a.config.host,port:Number(a.config.port||993),secure:true,auth:await mailAuth(a),logger:false,connectionTimeout:15000,socketTimeout:30000});try{await client.connect();return(await client.list()).filter(f=>!f.flags?.has('\\Noselect')).map(f=>({path:f.path,name:f.name,specialUse:f.specialUse,selected:this.folders(a).includes(f.path)}));}finally{await client.logout().catch(()=>client.close());}}
  async sync(a:Account):Promise<Batch>{const batch:Batch={threads:[],messages:[],assets:[]},errors=[];for(const folder of this.folders(a))try{const page=await this.read(a,false,folder);batch.threads.push(...page.threads);batch.messages.push(...page.messages);batch.assets!.push(...page.assets||[]);if(page.warning)errors.push(page.warning);}catch{errors.push('メールフォルダーの一部は取得できませんでした');}if(errors.length){batch.warning=[...new Set(errors)].join('。');batch.warningCode='partial_fetch';if(!batch.messages.length&&!batch.threads.length)throw Error('メールフォルダーを取得できません');}return batch;}
  async loadHistory(a:Account):Promise<Batch>{const history=this.history(a),folder=this.folders(a).find(f=>history[f]?.complete!==true);if(!folder)return{threads:[],messages:[]};return this.read(a,true,folder);}
  private async read(a:Account,older:boolean,folder='INBOX'):Promise<Batch>{
    const history=this.history(a),cursor=history[folder]??(folder==='INBOX'?{validity:a.config.imapHistoryValidity,before:a.config.imapBeforeUid,complete:a.config.imapHistoryComplete==='true'}:{});
    const saveHistory=()=>{history[folder]=cursor;a.config.mailFolderHistory=JSON.stringify(history);a.config.imapHistoryComplete=String(this.folders(a).every(f=>history[f]?.complete));};
    const client=this.createClient({host:a.config.host,port:Number(a.config.port||993),secure:true,auth:await mailAuth(a),logger:false,connectionTimeout:15000,socketTimeout:30000});
    const batch:Batch={threads:[],messages:[]};
    try{
      await client.connect(); const box=await client.mailboxOpen(folder,{readOnly:true});
      if(!box.exists){cursor.complete=true;saveHistory();return batch;}
      const validity=String(box.uidValidity),reset=cursor.validity!==validity;
      let range:string,uid=false,complete=false;
      if(older){
        if(reset||!cursor.before)throw Error('先に最新のメールを同期してください');
        const before=Number(cursor.before);if(!Number.isSafeInteger(before)||before<1)throw Error('履歴の位置が無効です');
        if(before===1){cursor.complete=true;saveHistory();return batch;}
        const found=await client.search({uid:'1:'+(before-1)},{uid:true});
        const ids=Array.isArray(found)?found.filter(id=>Number.isSafeInteger(id)&&id>0&&id<before).sort((x,y)=>x-y):[];
        complete=ids.length<=200;if(!ids.length){cursor.complete=true;saveHistory();return batch;}
        range=ids.slice(-200).join(',');uid=true;
      }else if(!reset&&cursor.highest&&Number(box.uidNext)>cursor.highest+1){const found=await client.search({uid:(cursor.highest+1)+':*'},{uid:true}),ids=Array.isArray(found)?found.filter(id=>id>cursor.highest!).sort((x,y)=>x-y):[];if(!ids.length){range=`${Math.max(1,box.exists-199)}:*`;}else{range=ids.slice(0,500).join(',');uid=true;if(ids.length>500){batch.warning='未取得メールを500通ずつ取り込んでいます。残りは次回の同期で取得します。';batch.warningCode='partial_fetch';}}complete=false;}else{range=`${Math.max(1,box.exists-199)}:*`;complete=box.exists<=200;}
      let oldest=Number.POSITIVE_INFINITY,skipped=0,assetBytes=0;
      // source uses BODY.PEEK[] in ImapFlow; EXAMINE prevents server-side Seen mutations.
      for await(const item of client.fetch(range,{uid:true,source:true,envelope:true,flags:true},{uid})){
        oldest=Math.min(oldest,item.uid);if(!older)cursor.highest=Math.max(cursor.highest||0,item.uid);
        if(!item.source || item.source.length>35*1024*1024){skipped++;continue;}
        const mail=await simpleParser(item.source,{skipHtmlToText:false,skipTextToHtml:true});
        const references=Array.isArray(mail.references)?mail.references:mail.references?[mail.references]:[];
        const root=references[0]||mail.inReplyTo||mail.messageId||`${box.uidValidity}:${item.uid}`;
        const threadId=createHash('sha256').update(root).digest('hex');
        const ts=mail.date?.getTime()||0; const sender=mail.from?.text||'不明';
        const messageId=(folder==='INBOX'?'':Buffer.from(folder).toString('base64url')+':')+`${box.uidValidity}:${item.uid}`;
        const attachments=mail.attachments.map((f,index)=>{let blobId:string|undefined;if(f.content.length<=25*1024*1024&&assetBytes+f.content.length<=64*1024*1024){blobId=assetId(a.id,messageId,index,f.content);(batch.assets??=[]).push({id:blobId,accountId:a.id,threadId,messageId,name:f.filename||'attachment',mime:f.contentType,data:f.content});assetBytes+=f.content.length;}return{name:f.filename||'attachment',kind:f.contentType,size:f.size,blobId,remoteId:JSON.stringify({mailbox:folder,validity:String(box.uidValidity),uid:item.uid,index})};});
        batch.messages.push({id:messageId,accountId:a.id,threadId,sender,senderId:mail.from?.value[0]?.address,text:mail.text||'（テキスト本文なし）',mailbox:folder,mailUid:item.uid,mailValidity:String(box.uidValidity),sourceUnread:item.flags? !item.flags.has('\\Seen'):undefined,ts,isMe:mail.from?.value.some(v=>v.address?.toLowerCase()===a.config.user.toLowerCase())||false,attachments,replyTo:mail.inReplyTo,mailMessageId:mail.messageId,mailReferences:references});
        const own=mail.from?.value.some(v=>v.address?.toLowerCase()===a.config.user.toLowerCase());const to=mail.to?(Array.isArray(mail.to)?mail.to.flatMap(x=>x.value):mail.to.value):[];const replyAddress=own?to[0]?.address:mail.replyTo?.value[0]?.address||mail.from?.value[0]?.address;
        const cc=mail.cc?(Array.isArray(mail.cc)?mail.cc.flatMap(x=>x.value):mail.cc.value):[];const replyCc=[...new Set([...to,...cc].flatMap(v=>v.address&&v.address.toLowerCase()!==a.config.user.toLowerCase()&&v.address.toLowerCase()!==replyAddress?.toLowerCase()?[v.address]:[]))];
        const old=batch.threads.find(t=>t.id===threadId);if(old){if(ts>=old.updatedAt){old.replyAddress=replyAddress;old.replyCc=replyCc;old.mailReferences=references;old.replyMessageId=mail.messageId;}old.updatedAt=Math.max(old.updatedAt,ts);if(!old.members.includes(sender))old.members.push(sender);}else batch.threads.push({id:threadId,accountId:a.id,title:mail.subject||'（件名なし）',isGroup:(mail.to? (Array.isArray(mail.to)?mail.to.flatMap(x=>x.value):mail.to.value):[]).length>1,updatedAt:ts,members:[sender,...[...to,...cc].map(v=>v.name||v.address||'不明')],membersComplete:false,replyAddress,replyCc,mailReferences:references,replyMessageId:mail.messageId});
      }
      for(const thread of batch.threads){const messages=batch.messages.filter(m=>m.threadId===thread.id);if(messages.every(m=>m.sourceUnread!==undefined)){thread.sourceUnreadCount=messages.filter(m=>m.sourceUnread).length;thread.sourceUnread=thread.sourceUnreadCount>0;}}
      if(Number.isFinite(oldest)){cursor.validity=validity;cursor.before=String(reset?oldest:Math.min(Number(cursor.before)||oldest,oldest));if(older||reset)cursor.complete=complete;saveHistory();}
      if(skipped){batch.warning=skipped+'通は本文未取得または35MBを超えるため読み込みを省略しました。元のメール画面で確認してください。';batch.warningCode='partial_fetch';}
      return batch;
    }finally{await client.logout().catch(()=>client.close());}
  }
  async markRead(a:Account,_thread:Thread,message:import('../model.js').Message){
    if(!message.mailUid||!message.mailValidity)throw Error('メールを再同期してから既読にしてください');const client=this.createClient({host:a.config.host,port:Number(a.config.port||993),secure:true,auth:await mailAuth(a),logger:false,connectionTimeout:15000,socketTimeout:30000});try{await client.connect();const box=await client.mailboxOpen(message.mailbox||'INBOX');if(String(box.uidValidity)!==message.mailValidity)throw Error('メールボックスが更新されています');await client.messageFlagsAdd(String(message.mailUid),['\\Seen'],{uid:true});}finally{await client.logout().catch(()=>client.close());}
  }
  async sendText(a:Account,t:Thread,text:string,id:string){return this.sendContent(a,t,{text,files:[]},id);}
  async downloadAttachment(a:Account,file:Attachment){
    let ref:{mailbox:string;validity:string;uid:number;index:number};try{ref=JSON.parse(file.remoteId||'');}catch{const match=file.remoteId?.match(/^(\d+):(\d+):(\d+)$/);if(!match)throw Error('先にメールの履歴を再取得してください');ref={mailbox:'INBOX',validity:match[1],uid:Number(match[2]),index:Number(match[3])};}
    if(!ref||typeof ref.mailbox!=='string'||!/^\d+$/.test(ref.validity)||!Number.isSafeInteger(ref.uid)||ref.uid<1||!Number.isInteger(ref.index)||ref.index<0)throw Error('メール添付の参照が無効です');const folder=ref.mailbox;
    const client=this.createClient({host:a.config.host,port:Number(a.config.port||993),secure:true,auth:await mailAuth(a),logger:false,connectionTimeout:15000,socketTimeout:30000});
    try{await client.connect();const box=await client.mailboxOpen(folder,{readOnly:true});if(String(box.uidValidity)!==ref.validity)throw Error('メールボックスが更新されています。再同期してください');const item=await client.fetchOne(String(ref.uid),{source:true},{uid:true});if(!item||!item.source||item.source.length>35*1024*1024)throw Error('このメールの添付を取得できません');const mail=await simpleParser(item.source,{skipHtmlToText:true,skipTextToHtml:true}),attachment=mail.attachments[ref.index];if(!attachment)throw Error('添付が見つかりません');return attachment.content;}finally{await client.logout().catch(()=>client.close());}
  }
  async sendContent(a:Account,t:Thread,content:SendContent,id:string){if(!a.config.smtpHost||!t.replyAddress)throw Error('SMTP設定または返信先がありません');const port=Number(a.config.smtpPort||465);const transport=this.transport({host:a.config.smtpHost,port,secure:port===465,requireTLS:true,auth:a.config.oauthProvider?{type:'OAuth2' as const,user:a.config.user,accessToken:await mailAccessToken(a)}:{user:a.config.user,pass:a.config.smtpPassword||a.config.password},logger:false,debug:false,connectionTimeout:15000,socketTimeout:30000});try{const reply=content.replyTo||t.replyMessageId;const result=await transport.sendMail({from:a.config.user,to:t.replyAddress,cc:content.cc,bcc:content.bcc,subject:t.composeMode==='new'?t.title:/^re:/i.test(t.title)?t.title:'Re: '+t.title,text:content.text,inReplyTo:reply,references:content.references||[...new Set([...(t.mailReferences||[]),...(reply?[reply]:[])])],attachments:content.files.map(f=>({filename:f.name,content:f.data,contentType:f.mime})),messageId:`<${id}@relaydesk.local>`});return{id:String(result.messageId)};}finally{transport.close();}}
}
