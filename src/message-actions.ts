import {randomUUID,randomBytes,createHash} from 'node:crypto';
import type {State,Adapter} from './model.js';
export type ActionKind='edit'|'delete'|'react-add'|'react-remove';
export type ApprovedMessageAction={kind:ActionKind;messageId:string;messageTimestamp:number;threadRoot?:string;text?:string;emoji?:string;expectedText:string;isMe:boolean;remoteTransport?:'plain'|'e2ee'};
export type MessageAction={id:string;accountId:string;threadId:string;messageId:string;kind:ActionKind;text?:string;emoji?:string;expectedHash:string;createdAt:number;status:'pending'|'running'|'done'|'uncertain'|'resolved';finishedAt?:number};
const textHash=(text:string)=>createHash('sha256').update(text).digest('hex');
const labels:Record<ActionKind,string>={edit:'メッセージを編集',delete:'メッセージを削除・送信取消','react-add':'リアクションを追加','react-remove':'自分のリアクションを取り消し'};
export class MessageActions{
  private approvals=new Map<string,{id:string;digest:string;expires:number}>();
  constructor(private state:State,private adapters:Record<string,Adapter>,private save:()=>void){for(const action of state.operations||[])if(action.status==='running')action.status='uncertain';}
  private context(action:MessageAction){
    const account=this.state.accounts.find(a=>a.id===action.accountId),thread=this.state.threads.find(t=>t.accountId===action.accountId&&t.id===action.threadId),message=this.state.messages.find(m=>m.accountId===action.accountId&&m.threadId===action.threadId&&m.id===action.messageId);
    const adapter=account?this.adapters[account.adapter]:undefined;if(!account||!thread||!message||message.deleted||!adapter?.performAction||account.config.coreReadOnly==='true'||account.config.authOnly==='true')throw Error('このメッセージの操作には対応していません');
    if(adapter.canSendThread?.(account,thread)===false)throw Error('暗号化連携の端末登録を先に完了してください');
    if((action.kind==='edit'||action.kind==='delete')&&!message.isMe)throw Error('自分のメッセージだけを編集・削除できます');
    const feature=action.kind==='edit'?'edit':action.kind==='delete'?'delete':'reactions';if(!adapter.features?.[feature])throw Error('この操作は元サービスの画面から行ってください');
    if(textHash(message.text)!==action.expectedHash)throw Error('対象の本文が更新されました。内容を確認して操作をやり直してください');
    return{account,thread,message,adapter};
  }
  stage(input:any){
    if(!['edit','delete','react-add','react-remove'].includes(input.kind))throw Error('メッセージ操作が無効です');
    const message=this.state.messages.find(m=>m.accountId===input.accountId&&m.threadId===input.threadId&&m.id===input.messageId);if(!message||message.unavailable||message.deleted)throw Error('操作できるメッセージがありません');
    if(input.kind==='edit'&&(typeof input.text!=='string'||!input.text.trim()||input.text.length>10000))throw Error('編集後の本文を1〜10000文字で入力してください');
    if(input.kind.startsWith('react-')&&(typeof input.emoji!=='string'||!input.emoji.trim()||input.emoji.length>100||/[\r\n]/.test(input.emoji)))throw Error('リアクションを指定してください');
    const action:MessageAction={id:randomUUID(),accountId:message.accountId,threadId:message.threadId,messageId:message.id,kind:input.kind,text:input.kind==='edit'?input.text:undefined,emoji:input.kind.startsWith('react-')?input.emoji:undefined,expectedHash:textHash(message.text),createdAt:Date.now(),status:'pending'};
    this.context(action);(this.state.operations??=[]).push(action);this.save();return{id:action.id,executed:false};
  }
  private target(id:string){const action=this.state.operations?.find(a=>a.id===id&&a.status==='pending');if(!action)throw Error('承認待ちの操作がありません');return{action,...this.context(action)};}
  private digest(id:string){const {action,account,thread}=this.target(id);return textHash(JSON.stringify([action,account.id,account.config.viewerId,account.config.teamId,thread.title]));}
  prepare(id:string){const {action,account,thread,message}=this.target(id),challenge=randomBytes(32).toString('hex');this.approvals.set(challenge,{id,digest:this.digest(id),expires:Date.now()+300000});return{challenge,preview:{action:labels[action.kind],service:account.service,account:account.name,recipient:thread.title,message:message.text,text:action.text,emoji:action.emoji}};}
  async approve(id:string,challenge:string,explicit:boolean){
    const approval=this.approvals.get(challenge);this.approvals.delete(challenge);if(!explicit||!approval||approval.id!==id||approval.expires<Date.now()||approval.digest!==this.digest(id))throw Error('内容が変わったか承認が無効です。もう一度確認してください');
    const {action,account,thread,message,adapter}=this.target(id);action.status='running';this.save();
    try{
      await adapter.performAction!(account,thread,{kind:action.kind,messageId:message.id,messageTimestamp:message.ts,threadRoot:message.replyTo,text:action.text,emoji:action.emoji,expectedText:message.text,remoteTransport:message.remoteTransport,isMe:message.isMe},action.id);
      action.status='done';action.finishedAt=Date.now();
      if(action.kind==='edit'){message.text=action.text!;message.editedAt=Date.now();if(account.adapter==='messenger')message.revision=(message.revision||0)+1;}
      if(action.kind==='delete'){message.deleted=true;message.text='';message.attachments=[];}
      if(action.kind.startsWith('react-')){const rows=message.reactions??=[],old=rows.find(r=>r.name===action.emoji),add=action.kind==='react-add';if(old){old.count=Math.max(0,old.count+(add&&!old.mine?1:!add&&old.mine?-1:0));old.mine=add;}else if(add)rows.push({name:action.emoji!,count:1,mine:true});}
      delete action.text;this.save();return{executed:true};
    }catch(error){if(error instanceof Error&&(error as any).definitelyNotSent===true){action.status='pending';this.save();throw error;}action.status='uncertain';this.save();throw Error('操作結果を確定できません。自動で再実行せず、元サービスの画面で確認してください');}
  }
  discard(id:string){const action=this.state.operations?.find(a=>a.id===id&&a.status==='pending');if(!action)throw Error('取り消せる承認待ちの操作がありません');this.state.operations=this.state.operations?.filter(a=>a!==action);this.save();}
  resolve(id:string){const action=this.state.operations?.find(a=>a.id===id&&a.status==='uncertain');if(!action)throw Error('結果確認待ちの操作がありません');action.status='resolved';action.finishedAt=Date.now();delete action.text;this.save();}
}
