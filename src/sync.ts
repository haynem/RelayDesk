import {mergeConfig} from './auth-config.js';
import {key,mergeBatch,type State,type Account,type Adapter,type Batch,type BatchAsset,type StoredAsset,type Thread} from './model.js';
import {rememberAsset} from './assets.js';
import {newNotificationTargets,type NotificationTarget} from './desktop-notification-policy.js';
import {observeLearning,refreshProposals} from './learning.js';
/** Bound independent account reads; a slow connector must not hold up every other service. */
export class SyncCoordinator{
  readonly busy=new Set<string>();syncing=false;private stopping=false;private active?:Promise<void>;
  constructor(private state:State,private adapters:Record<string,Adapter>,private save:()=>void,private notify?:(targets:NotificationTarget[])=>void,private storeAsset?:(asset:BatchAsset)=>StoredAsset){}
  sync(force=false):Promise<void>{
    if(this.stopping)return Promise.resolve();if(this.active)return this.active;
    this.syncing=true;
    const now=Date.now(),queue=this.state.accounts.filter(a=>force||(a.connection?.nextAttemptAt||0)<=now);
    const worker=async()=>{while(queue.length&&!this.stopping){const account=queue.shift()!;if(this.busy.has(account.id)||!this.state.accounts.includes(account))continue;this.busy.add(account.id);try{await this.read(account,false);}finally{this.busy.delete(account.id);}}};
    this.active=Promise.all(Array.from({length:Math.min(3,queue.length)},worker)).then(()=>{if(!this.stopping){this.state.syncStatus={at:Date.now(),ok:!this.state.accounts.some(a=>a.error)};this.save();}}).finally(()=>{this.syncing=false;this.active=undefined;});
    return this.active;
  }
  async history(accountId:string){
    const account=this.state.accounts.find(a=>a.id===accountId);if(this.stopping||!account||!this.adapters[account.adapter]?.loadHistory)throw Error('この接続は追加の履歴取得に対応していません');
    if(this.busy.has(accountId))throw Error('この接続を同期中です。完了してからお試しください');
    this.busy.add(accountId);try{await this.read(account,true);}finally{this.busy.delete(accountId);}
  }
  stop(){this.stopping=true;}
  async threadHistory(accountId:string,threadId:string,before?:string){
    const account=this.state.accounts.find(a=>a.id===accountId),thread=this.state.threads.find(t=>t.accountId===accountId&&t.id===threadId);if(!account||!thread||(!this.adapters[account.adapter]?.loadThread||this.adapters[account.adapter].canPageThread?.(account)===false))throw Error('この会話の追加取得には対応していません');
    if(this.busy.has(accountId))throw Error('この接続を同期中です');this.busy.add(accountId);
    try{const batch=await this.adapters[account.adapter].loadThread!(account,thread,before);if(this.stopping||!this.state.accounts.includes(account))return;this.merge(account,batch);this.save();}finally{this.busy.delete(accountId);}
  }
  async replies(accountId:string,threadId:string,messageId:string){
    const account=this.state.accounts.find(a=>a.id===accountId),thread=this.state.threads.find(t=>t.accountId===accountId&&t.id===threadId),message=this.state.messages.find(m=>m.accountId===accountId&&m.threadId===threadId&&m.id===messageId);if(!account||!thread||!message||!this.adapters[account.adapter]?.loadReplies)throw Error('返信スレッドの取得には対応していません');
    if(this.busy.has(accountId))throw Error('この接続を同期中です');this.busy.add(accountId);
    try{const batch=await this.adapters[account.adapter].loadReplies!(account,thread,message);if(this.stopping||!this.state.accounts.includes(account))return;this.merge(account,batch);if(batch.warning){account.error=batch.warning;account.errorCode='partial_fetch';}this.save();}finally{this.busy.delete(accountId);}
  }
  async members(accountId:string,threadId:string){
    const account=this.state.accounts.find(a=>a.id===accountId),thread=this.state.threads.find(t=>t.accountId===accountId&&t.id===threadId);if(!account||!thread||!this.adapters[account.adapter]?.loadMembers)throw Error('全参加者の取得には対応していません');
    if(this.busy.has(accountId))throw Error('この接続を同期中です');this.busy.add(accountId);
    try{const members=await this.adapters[account.adapter].loadMembers!(account,thread);if(this.stopping||!this.state.accounts.includes(account))return;thread.memberRecords=members;thread.members=members.map(m=>m.name);thread.membersComplete=true;this.save();}finally{this.busy.delete(accountId);}
  }
  async fillGap(accountId:string,threadId:string){
    const account=this.state.accounts.find(a=>a.id===accountId);if(!account||this.stopping)throw Error('接続がありません');if(this.busy.has(accountId))throw Error('この接続を同期中です');this.busy.add(accountId);
    try{await this.fillGapPages(account,threadId,10,true);}finally{this.busy.delete(accountId);}
  }
  private async fillGapPages(account:Account,threadId:string,pages:number,manual=false){
    const gap=this.state.syncGaps?.find(g=>g.accountId===account.id&&g.threadId===threadId),adapter=this.adapters[account.adapter];if(!gap||!adapter?.loadThread||!manual&&(gap.nextRetryAt||0)>Date.now())return;
    for(let page=0;page<pages&&!this.stopping;page++){
      try{const batch=await adapter.loadThread(account,gap.thread,gap.before);if(this.stopping||!this.state.accounts.includes(account))return;const rows=batch.messages.filter(m=>m.accountId===account.id&&m.threadId===threadId).sort((x,y)=>x.ts-y.ts),first=rows[0],before=first&&(first.historyCursor||first.id);if(!first||before===gap.before)throw Error('gap_not_progressed');this.merge(account,batch);gap.before=before;delete gap.nextRetryAt;if(first.ts<=gap.targetTs){this.state.syncGaps=this.state.syncGaps?.filter(g=>g!==gap);this.save();return;}this.save();}
      catch{gap.nextRetryAt=Date.now()+900000;this.save();if(manual)throw Error('未取得範囲の補完を続けられませんでした。権限・取得制限を確認し、後で再度お試しください');return;}
    }
  }
  private merge(account:Account,batch:Batch){
    for(const asset of batch.assets||[])if(asset.accountId!==account.id||!batch.messages.some(m=>m.accountId===asset.accountId&&m.threadId===asset.threadId&&m.id===asset.messageId&&m.attachments.some(a=>a.blobId===asset.id)))throw Error('添付の接続先が一致しません');
    const assets=this.storeAsset?(batch.assets||[]).map(a=>this.storeAsset!(a)):[];mergeBatch(this.state,account,batch);for(const asset of assets)rememberAsset(this.state,asset);
  }
  private async read(account:Account,history:boolean){
    const originalConfig=account.config,configBaseline={...originalConfig},working={...account,config:{...configBaseline}};
    if(!history){account.connection??={failures:0,nextAttemptAt:0};account.connection.startedAt=Date.now();this.save();}
    try{
      const adapter=this.adapters[account.adapter];if(!adapter)throw Error('Connector unavailable');
      const since=account.lastSync,known=new Set(this.state.messages.filter(m=>m.accountId===account.id).map(m=>key(m.accountId,m.threadId,m.id)));
      const batch:Batch=await (history?adapter.loadHistory!(working):adapter.sync(working));
      if(this.stopping||!this.state.accounts.includes(account)||account.config!==originalConfig)return;
      if(!history&&since&&adapter.loadThread&&adapter.canPageThread?.(working)!==false){
        // A latest-page window can leave a gap after sleep. Walk older pages until the last cached message.
        for(const thread of batch.threads){
          const previous=this.state.messages.filter(m=>m.accountId===account.id&&m.threadId===thread.id),latest=previous.reduce((max,m)=>Math.max(max,m.ts),0);let rows=batch.messages.filter(m=>m.threadId===thread.id),first=rows.slice().sort((x,y)=>x.ts-y.ts)[0];
          if(!latest||!first||first.ts<=latest||account.adapter==='messenger'&&thread.remoteEncrypted)continue;
          const paging={...thread};let pages=0,gap=true;const seen=new Set(rows.map(m=>m.id));
          while(gap&&pages++<10&&!this.stopping){
            try{const page=await adapter.loadThread(working,paging,first.historyCursor||first.id),newRows=page.messages.filter(m=>m.threadId===thread.id&&!seen.has(m.id));if(!newRows.length)break;for(const m of newRows)seen.add(m.id);batch.messages.push(...newRows);(batch.assets??=[]).push(...page.assets||[]);first=newRows.slice().sort((x,y)=>x.ts-y.ts)[0];gap=first.ts>latest;if(page.warning)batch.warning=page.warning;}
            catch{break;}
          }
          if(gap){const gaps=this.state.syncGaps??=[],existing=gaps.find(g=>g.accountId===account.id&&g.threadId===thread.id),saved={accountId:account.id,threadId:thread.id,targetTs:Math.min(existing?.targetTs??latest,latest),before:first.historyCursor||first.id,thread:paging,createdAt:existing?.createdAt||Date.now()};if(existing)Object.assign(existing,saved);else gaps.push(saved);batch.warning='復帰後に未取得の範囲があります。次回以降の同期・会話画面から補完を継続します。';batch.warningCode='partial_fetch';}
        }
      }
      if(this.stopping||!this.state.accounts.includes(account))return;
      if(account.config!==originalConfig)return;
      if(!history)for(const thread of batch.threads)thread.lastSync=Date.now();
      this.merge(account,batch);mergeConfig(originalConfig,configBaseline,working.config);if(!history)account.connection={failures:0,nextAttemptAt:Date.now()+60000,startedAt:account.connection?.startedAt,completedAt:Date.now()};if(!history){if(since)for(const message of batch.messages)if(message.ts>=since&&!known.has(key(message.accountId,message.threadId,message.id)))observeLearning(this.state,'received',message);account.lastSync=Date.now();refreshProposals(this.state);}
      if(batch.warning){account.error=batch.warning;account.errorCode=batch.warningCode||'partial_decryption';}else{delete account.error;delete account.errorCode;}
      this.save();if(!history){const gap=this.state.syncGaps?.find(g=>g.accountId===account.id);if(gap)await this.fillGapPages(account,gap.threadId,2);if(this.state.syncGaps?.some(g=>g.accountId===account.id)){account.error='未取得の履歴を補完中です。取得制限がある場合は後で自動再開します。';account.errorCode='history_gap';this.save();}}if(!history)try{this.notify?.(newNotificationTargets(this.state,account,batch,known,since));}catch{}
    }catch(error){
      if(this.stopping||!this.state.accounts.includes(account)||account.config!==originalConfig)return;
      // Persist rotated OAuth/session credentials even when the subsequent read failed.
      if(account.config===originalConfig)mergeConfig(originalConfig,configBaseline,working.config);
      if(!history){const failures=Math.min(10,(account.connection?.failures||0)+1),delay=Math.min(900000,30000*2**(failures-1))+Math.floor(Math.random()*5000);account.connection={failures,nextAttemptAt:Date.now()+delay,startedAt:account.connection?.startedAt,completedAt:account.connection?.completedAt,lastErrorAt:Date.now()};}
      const message=error instanceof Error?error.message:'';
      account.errorCode=/^Instagram (HTTP \d{3}|GraphQL \d+|identity_mismatch|invalid_json|api_unavailable|reauth_required|rate_limited|read_path_denied|page_tokens_missing|graphql_error|schema_changed)$/.test(message)||/^Slack (identity_mismatch|rate_limited|history_unavailable)$/.test(message)?message:'connection_failed';
      account.error=account.adapter==='sendy'?'Sendyを起動し、AI接続のキーと接続番号を確認してください。':account.adapter==='instagram'?'Instagramの会話を取得できませんでした。診断コード: '+account.errorCode:account.errorCode==='Slack rate_limited'?'Slackの取得制限中です。指定された待ち時間が過ぎてから再取得します。':'接続できません。サーバー・認証・権限・取得制限を確認してください。';
      this.save();if(history)throw Error('以前の履歴を取得できませんでした。接続状態を確認してください');
    }
  }
}
