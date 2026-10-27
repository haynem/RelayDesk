import {randomUUID} from 'node:crypto';
import type {Vault} from './vault.js';
import type {Adapter,Draft,StoredAsset,OutgoingFile} from './model.js';
import {assetId,assetForMessage,rememberAsset,MAX_ASSET_BYTES} from './assets.js';
export type PickedFile={name:string;mime:string;data:Buffer};
export type FileHooks={pickFiles?:()=>Promise<PickedFile[]>;exportFile?:(name:string,data:Buffer)=>Promise<boolean>};
const safeMime=(value:string)=>/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value)?value:'application/octet-stream';
export class AssetService{
  constructor(private vault:Vault,private adapters:Record<string,Adapter>,private hooks:FileHooks){}
  draftFiles(draft:Draft):OutgoingFile[]{
    return(draft.fileIds||[]).map(id=>{const asset=this.vault.state.assets?.find(a=>a.id===id&&a.accountId===draft.accountId&&a.draftId===draft.id);if(!asset)throw Error('返信案の添付がありません');return{name:asset.name,mime:asset.mime,data:this.vault.assets.read(asset)};});
  }
  resolve(input:any):StoredAsset{
    const state=this.vault.state;
    if(input.messageId)return assetForMessage(state,String(input.accountId||''),String(input.threadId||''),String(input.messageId),String(input.assetId||''));
    const draft=state.drafts.find(d=>d.id===input.draftId&&d.accountId===input.accountId);if(!draft?.fileIds?.includes(input.assetId))throw Error('返信案の添付がありません');
    const asset=state.assets?.find(a=>a.id===input.assetId&&a.accountId===input.accountId&&a.draftId===draft.id);if(!asset)throw Error('添付の実体がありません');return asset;
  }
  async route(path:string,input:any){
    const state=this.vault.state;
    if(path==='/api/pick-draft-files'){
      if(!this.hooks.pickFiles)throw Error('この起動環境ではファイルを選択できません');
      const account=state.accounts.find(a=>a.id===input.accountId),thread=state.threads.find(t=>t.accountId===input.accountId&&t.id===input.threadId);if(!account||!thread)throw Error('接続または会話がありません');
      if(!this.adapters[account.adapter]?.sendContent||this.adapters[account.adapter].features?.files!==true||account.config.authOnly==='true'||account.config.coreReadOnly==='true'||this.adapters[account.adapter].canSendThread?.(account,thread)===false)throw Error('この接続の添付送信は元のサービス画面から操作してください');
      const old=input.draftId?state.drafts.find(d=>d.id===input.draftId&&d.accountId===account.id&&d.threadId===thread.id&&d.status==='pending'):undefined;
      if(input.draftId&&!old)throw Error('添付を追加できる返信案がありません');
      const text=old?.text??input.text??'';if(typeof text!=='string'||text.length>10000)throw Error('返信案の本文が無効です');
      const files=await this.hooks.pickFiles();if(!files.length)return{cancelled:true};
      if(!state.accounts.includes(account)||!state.threads.some(t=>t.accountId===account.id&&t.id===thread.id)||old&&(!state.drafts.includes(old)||old.status!=='pending'))throw Error('ファイル選択中に返信先が変更されました');
      const previousBytes=(old?.fileIds||[]).reduce((sum,id)=>sum+(state.assets?.find(a=>a.id===id&&a.draftId===old?.id)?.size||0),0);
      if(files.length+(old?.fileIds?.length||0)>10||files.some(f=>f.data.length>MAX_ASSET_BYTES)||files.reduce((sum,f)=>sum+f.data.length,previousBytes)>100*1024*1024)throw Error('添付は10個まで、1個25MB・合計100MBまでです');
      const draft:Draft=old||{id:randomUUID(),accountId:account.id,threadId:thread.id,text,replyTo:input.replyTo,emailCc:input.emailCc,createdAt:Date.now(),status:'pending'};
      const assets=files.map((f,index)=>this.vault.assets.put({id:assetId(account.id,draft.id,(draft.fileIds?.length||0)+index,f.data),accountId:account.id,draftId:draft.id,name:f.name,mime:safeMime(f.mime),data:f.data}));
      if(!old){state.drafts.push(draft);state.composerDrafts=(state.composerDrafts||[]).filter(d=>d.accountId!==account.id||d.threadId!==thread.id);}draft.fileIds=[...(draft.fileIds||[]),...assets.map(a=>a.id)];for(const asset of assets)rememberAsset(state,asset);this.vault.save();return{draftId:draft.id,cancelled:false};
    }
    if(path==='/api/remove-draft-file'){
      const draft=state.drafts.find(d=>d.id===input.draftId&&d.status==='pending');if(!draft?.fileIds?.includes(input.assetId))throw Error('取り消せる添付がありません');
      const asset=this.resolve({accountId:draft.accountId,draftId:draft.id,assetId:input.assetId});draft.fileIds=draft.fileIds.filter(id=>id!==asset.id);state.assets=state.assets?.filter(a=>a!==asset);this.vault.save();this.vault.assets.remove(asset.id);return{ok:true,remoteChanged:false};
    }
    if(path==='/api/download-attachment'){
      const account=state.accounts.find(a=>a.id===input.accountId),message=state.messages.find(m=>m.accountId===input.accountId&&m.threadId===input.threadId&&m.id===input.messageId);
      if(!account||!message||!Number.isInteger(input.index)||input.index<0||input.index>=message.attachments.length)throw Error('添付がありません');
      const file=message.attachments[input.index];if(file.blobId){const stored=assetForMessage(state,account.id,message.threadId,message.id,file.blobId);this.vault.assets.read(stored);return this.publicAsset(stored);}
      const adapter=this.adapters[account.adapter];if(!adapter.downloadAttachment)throw Error('この添付の実体は元サービスの画面で確認してください');
      const bytes=await adapter.downloadAttachment(account,file);if(!state.accounts.includes(account)||!state.messages.includes(message))throw Error('取得中に会話が削除されました');
      const stored=this.vault.assets.put({id:assetId(account.id,JSON.stringify([message.threadId,message.id]),input.index,bytes),accountId:account.id,threadId:message.threadId,messageId:message.id,name:file.name,mime:safeMime(file.kind),data:bytes});file.blobId=stored.id;rememberAsset(state,stored);this.vault.save();return this.publicAsset(stored);
    }
    if(path==='/api/export-asset'){
      if(!this.hooks.exportFile)throw Error('この起動環境ではファイルを保存できません');const asset=this.resolve(input);return{saved:await this.hooks.exportFile(asset.name,this.vault.assets.read(asset))};
    }
    return undefined;
  }
  private publicAsset(asset:StoredAsset){return{assetId:asset.id,name:asset.name,mime:asset.mime,size:asset.size};}
}
