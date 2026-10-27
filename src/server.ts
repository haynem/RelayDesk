import {PersistentTunnel} from './persistent-tunnel.js';
import {GmailFilters} from './gmail-filters.js';
import {DiscordPersonalRpc,DiscordRpcError,type DiscordDiagnostic} from './discord-rpc.js';
import type {MessengerEncrypted} from './messenger-e2ee.js';
import {pcCapabilities} from './capabilities.js';
import type {PrivateTunnel,TunnelOptions} from './desktop-tunnel.js';
import {MessageActions} from './message-actions.js';
import {sendReadReceipt} from './read-receipts.js';
import {observeLearning,pruneLearning} from './learning.js';
import {AssetService,type FileHooks} from './asset-service.js';
import {RemoteMcp} from './remote-mcp.js';
import {learningRoute,learningSummary} from './learning-routes.js';
import type {NotificationTarget} from './desktop-notification-policy.js';
import {SyncCoordinator} from './sync.js';
import {createServer, type IncomingMessage} from 'node:http';
import {randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Vault} from './vault.js';
import {mergeBatch,services,key,type Account,type Adapter} from './model.js';
import {SlackAdapter} from './adapters/slack.js';
import {SendyAdapter} from './adapters/sendy.js';
import {ImapAdapter} from './adapters/imap.js';
import {mcp} from './mcp.js';
import {Outbox} from './outbox.js';
import QRCode from 'qrcode';
import {MobileGateway} from './mobile.js';
import {buildAttentionQueue} from './attention.js';
const eq=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req:IncomingMessage){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>100000)throw Error('入力が大きすぎます');}return JSON.parse(raw||'{}');}
export async function startServer(vault:Vault, uiDir:string, adapters:Record<string,Adapter>={slack:new SlackAdapter(),sendy:new SendyAdapter(),imap:new ImapAdapter()}, hooks:{quit?:()=>void;backgroundStatus?:()=>{preventSleep:boolean};setPreventSleep?:(enabled:boolean)=>void;messengerEncrypted?:MessengerEncrypted;resetConnection?:(id:string)=>Promise<void>;startupStatus?:()=>{supported:boolean;enabled:boolean};setStartup?:(enabled:boolean)=>void;tunnelSupported?:boolean;openTunnel?:(port:number,onExit:()=>void,options?:TunnelOptions)=>Promise<PrivateTunnel>;mailLogin?:(input:{provider:'google'|'microsoft';clientId?:string;gmailFilters?:boolean})=>Promise<Account>;instagramLogin?:()=>Promise<Account>;adoptLineLogin?:(fromId:string,toId:string)=>void;lineLogin?:(qr:(url:string)=>void,pin:(pin:string)=>void)=>Promise<Account>;serviceLogin?:(service:'slack'|'messenger')=>Promise<Account>;openService?:(service:string,accountId?:string,bounds?:{x:number;y:number;width:number;height:number},threadId?:string)=>Promise<void>;hideService?:()=>void;serviceBounds?:(bounds:{x:number;y:number;width:number;height:number})=>void;reloadService?:()=>void;notify?:(targets:NotificationTarget[])=>void;notificationSupported?:()=>boolean;testNotification?:()=>void;notificationSettingsChanged?:()=>void;openLink?:(url:string)=>Promise<void>;forget?:(id:string)=>Promise<void>}&FileHooks={}) {
  const session=randomBytes(32).toString('hex');let instagramLoginPending=false,instagramLoginError='';const state=vault.state;
  for(const a of state.accounts)if(a.adapter==='imap'&&a.name==='Gmail'&&a.config.user)a.name='Gmail · '+a.config.user;
  // A crash during sending is ambiguous; never automatically resend on restart.
  state.drafts.filter(d=>d.status==='sending').forEach(d=>{d.status='uncertain';});
  const gmailFilters=new GmailFilters(state,()=>vault.save());
  const messageActions=new MessageActions(state,adapters,()=>vault.save());
  const assetService=new AssetService(vault,adapters,hooks);
  const outbox=new Outbox(state,adapters,()=>vault.save(),draft=>assetService.draftFiles(draft));
  const discordRpc=new DiscordPersonalRpc(),discordLogin={pending:false,error:'',diagnostic:undefined as DiscordDiagnostic|undefined};
  const features=(account:Account)=>account.adapter==='discord'&&account.config.mode==='rpc'?{}:account.adapter==='messenger'&&account.config.homeserver?{}:adapters[account.adapter]?.features||{};
  const mailCopies=(input:any)=>{const account=state.accounts.find(a=>a.id===input.accountId),thread=state.threads.find(t=>t.accountId===input.accountId&&t.id===input.threadId);if(input.replyAll&&account?.adapter==='imap'&&thread)return thread.replyCc||[];return undefined;};
  const mailAddresses=(value:unknown)=>{if(value===undefined||value==='')return[];if(typeof value!=='string'||value.length>3000||/[\r\n]/.test(value))throw Error('CC・BCCはメールアドレスをカンマで区切ってください');const values=[...new Set(value.split(/[,;]+/).map(v=>v.trim()).filter(Boolean))];if(values.length>30||values.some(v=>v.length>254||!/^[^\s@<>,;:"()]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v)))throw Error('CC・BCCのメールアドレスを確認してください（各30件まで）');return values;};
  const validateQuote=(input:any)=>{
    if(!input.replyTo)return undefined;
    const account=state.accounts.find(a=>a.id===input.accountId),adapter=account&&adapters[account.adapter];
    if(!adapter?.features?.quote)throw Error('この接続では引用返信を利用できません');
    const message=state.messages.find(m=>m.accountId===input.accountId&&m.threadId===input.threadId&&!m.deleted&&!m.unavailable&&(m.id===input.replyTo||account?.adapter==='imap'&&m.mailMessageId===input.replyTo));
    if(!message)throw Error('引用元がありません');return account!.adapter==='imap'?message.mailMessageId:account!.adapter==='slack'?message.replyTo||message.id:message.id;
  };
  const prepareSelfMailTest=(accountId?:string)=>{
    const account=state.accounts.find(a=>(!accountId||a.id===accountId)&&a.adapter==='imap'&&a.config.user&&outbox.canSend(a.id));if(!account)throw Error('送信設定済みのメール接続がありません');
    const address=account.config.user;if(address.length>254||!/^[^\s@<>,;:"()]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(address))throw Error('メールアドレスの設定を確認してください');
    const subject='RelayDesk PC版 · 送信確認',text='RelayDesk PC版の送信テストです。';
    const previous=state.drafts.find(d=>d.accountId===account.id&&d.status==='pending'&&d.text===text&&state.threads.some(t=>t.accountId===account.id&&t.id===d.threadId&&t.title===subject&&t.replyAddress===address&&t.composeMode==='new'));if(previous)return{id:previous.id,threadId:previous.threadId,sent:false};
    const threadId='compose:'+randomUUID();state.threads.push({id:threadId,accountId:account.id,title:subject,updatedAt:Date.now(),isGroup:false,members:[address],membersComplete:true,replyAddress:address,composeMode:'new'});
    const draft={id:randomUUID(),accountId:account.id,threadId,text,createdAt:Date.now(),status:'pending' as const};state.drafts.push(draft);vault.save();return{id:draft.id,threadId,sent:false};
  };
  const remoteMcp=new RemoteMcp(state,()=>vault.save());const persistentTunnel=new PersistentTunnel(state,()=>vault.save(),remoteMcp,hooks.tunnelSupported?hooks.openTunnel:undefined);let tunnel:PrivateTunnel|undefined,tunnelEpoch=0;const tunnelStatus={pending:false,error:''};
  if(state.remoteMcp?.transient){state.remoteMcp.enabled=false;state.remoteMcp.origin='';state.remoteMcp.transient=false;state.remoteMcp.authorizations=[];for(const grant of state.remoteMcp.grants)grant.revoked=true;vault.save();}
  const stopTunnel=async()=>{tunnelEpoch++;const current=tunnel;tunnel=undefined;tunnelStatus.pending=false;await current?.close();if(state.remoteMcp){await remoteMcp.configure({enabled:false,origin:'',port:state.remoteMcp.port});state.remoteMcp.transient=false;vault.save();}};
  const startTunnel=async()=>{const epoch=++tunnelEpoch;tunnelStatus.pending=true;tunnelStatus.error='';try{
    const port=state.remoteMcp?.port||18765;await remoteMcp.configure({enabled:true,origin:'https://pending.relaydesk.invalid',port});if(!remoteMcp.status().listening)throw Error('listener_unavailable');
    const opened=await hooks.openTunnel!(port,()=>{if(epoch===tunnelEpoch)void stopTunnel().catch(()=>{});});if(epoch!==tunnelEpoch){await opened.close();return;}tunnel=opened;await remoteMcp.configure({enabled:true,origin:opened.origin,port});if(epoch!==tunnelEpoch)return;state.remoteMcp!.transient=true;vault.save();
  }catch{if(epoch===tunnelEpoch){await stopTunnel().catch(()=>{});tunnelStatus.error='簡易トンネルの準備が完了しませんでした。公式ツール・ネットワーク・ポートを確認してください。';}}finally{if(epoch===tunnelEpoch)tunnelStatus.pending=false;}};
  const mobile=new MobileGateway(state,()=>vault.save(),outbox);
  const mailLogin={pending:false,error:''};
  const serviceLogins:Record<string,{pending:boolean;error:string}>={slack:{pending:false,error:''},messenger:{pending:false,error:''}};
  const beginServiceLogin=(service:'slack'|'messenger')=>{if(!hooks.serviceLogin)throw Error('Login unavailable');if(serviceLogins[service].pending)return;serviceLogins[service]={pending:true,error:''};void hooks.serviceLogin(service).then(async account=>{
    if(account.service!==service||!account.config.viewerId)throw Error('Login account mismatch');
    const existing=state.accounts.find(a=>a.service===service&&a.adapter===account.adapter&&a.config.viewerId===account.config.viewerId&&(service!=='slack'||a.config.teamId===account.config.teamId));
    if(existing){await (hooks.resetConnection||hooks.forget)?.(existing.id);existing.config={...existing.config,...account.config};delete existing.error;delete existing.errorCode;}else state.accounts.push(account);
    vault.save();void sync();
  }).catch(()=>{serviceLogins[service].error='ログインが完了しませんでした。';}).finally(()=>{serviceLogins[service].pending=false;});};
  const lineLogin={pending:false,qrDataUrl:'',pin:'',error:''};
  const beginLineLogin=()=>{if(!hooks.lineLogin)throw Error('LINEログイン機能を利用できません');if(lineLogin.pending)return;Object.assign(lineLogin,{pending:true,qrDataUrl:'',pin:'',error:''});void hooks.lineLogin(url=>{void QRCode.toDataURL(url,{width:260,margin:2}).then(data=>{if(lineLogin.pending)lineLogin.qrDataUrl=data;});},pin=>{lineLogin.pin=pin;}).then(async account=>{const existing=state.accounts.find(a=>a.adapter==='line'&&a.config.viewerId===account.config.viewerId);if(existing){await hooks.forget?.(existing.id);existing.config={...existing.config,...account.config};hooks.adoptLineLogin?.(account.id,existing.id);delete existing.error;delete existing.errorCode;}else state.accounts.push(account);vault.save();void sync();}).catch(()=>{lineLogin.error='LINEのログインが完了しませんでした。もう一度お試しください。';}).finally(()=>{lineLogin.pending=false;lineLogin.qrDataUrl='';lineLogin.pin='';});};
  const coordinator=new SyncCoordinator(state,adapters,()=>vault.save(),hooks.notify,asset=>vault.assets.put(asset));
  const sync=()=>coordinator.sync(true);
  const beginInstagramLogin=()=>{
    if(!hooks.instagramLogin)throw Error('Instagramログイン機能を利用できません');
    if(instagramLoginPending)return;
    instagramLoginPending=true;instagramLoginError='';
    void hooks.instagramLogin().then(async account=>{
      const existing=state.accounts.find(a=>a.adapter==='instagram'&&a.config.viewerId===account.config.viewerId);if(existing){await hooks.forget?.(existing.id);existing.config={...existing.config,...account.config};await hooks.forget?.(account.id);delete existing.error;delete existing.errorCode;}else state.accounts.push(account);vault.save();void sync();
    }).catch(()=>{instagramLoginError='ログインが完了しませんでした。もう一度お試しください。';}).finally(()=>{instagramLoginPending=false;});
  };
  let port=0;
  const server=createServer(async(req,res)=>{
    const reply=(status:number,value:any)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    try {
      if(req.headers.host!==`127.0.0.1:${port}`)return reply(403,{error:'Host denied'});
      const url=new URL(req.url||'/',`http://127.0.0.1:${port}`);
      const origin=req.headers.origin;
      if(origin&&origin!==`http://127.0.0.1:${port}`)return reply(403,{error:'Origin denied'});
      if(url.pathname==='/mcp'){
        if(req.method!=='POST')return reply(405,{error:'POST required'});
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');
        if(!eq(token,state.mcpToken))return reply(401,{error:'Unauthorized'});
        const data=await body(req);if(!data||typeof data!=='object'||Array.isArray(data))return reply(400,{error:'Invalid RPC'});
        const value=mcp(state,data);vault.save();if(value===null){res.writeHead(202);res.end();return;}return reply(200,value);
      }
      if(url.pathname.startsWith('/api/')){
        if(!eq(String(req.headers['x-relay-session']||''),session))return reply(401,{error:'Unauthorized'});
        if(req.method==='GET'&&url.pathname==='/api/state')return reply(200,{accounts:state.accounts.map(({config,...a})=>({...a,canSend:outbox.canSend(a.id),gmailFilterSupported:gmailFilters.supported({...a,config}),gmailAccount:a.adapter==='imap'&&(config.oauthProvider==='google'||config.host==='imap.gmail.com'),discordMode:a.adapter==='discord'?config.mode:undefined,discordChannels:a.adapter==='discord'&&config.mode==='rpc'?config.channels:undefined,e2ee:a.adapter==='messenger'?hooks.messengerEncrypted?.status(a.id):undefined,canSendFiles:outbox.canSend(a.id)&&features({...a,config}).files===true,features:features({...a,config}),canLoadThread:!!adapters[a.adapter]?.loadThread&&adapters[a.adapter]?.canPageThread?.({...a,config})!==false&&!(a.adapter==='messenger'&&config.homeserver),canLoadReplies:!!adapters[a.adapter]?.loadReplies,canLoadMembers:!!adapters[a.adapter]?.loadMembers,canLoadHistory:!!adapters[a.adapter]?.loadHistory,mailFolders:a.adapter==='imap'?(adapters[a.adapter] as ImapAdapter).folders({...a,config}):undefined,historyComplete:config.imapHistoryComplete==='true',busy:coordinator.busy.has(a.id)})),threads:state.threads,messages:state.messages,drafts:state.drafts,syncGaps:(state.syncGaps||[]).map(({accountId,threadId,createdAt,nextRetryAt})=>({accountId,threadId,createdAt,nextRetryAt})),assets:state.assets||[],operations:state.operations||[],composerDrafts:state.composerDrafts||[],desktopNotifications:state.desktopNotifications||{enabled:true,minimum:'all'},desktopNotificationSupported:hooks.notificationSupported?.()||false,syncing:coordinator.syncing,draftAllowed:state.draftAllowed,instagramLoginPending,instagramLoginError,lineLogin,serviceLogins,mailLogin,discordLogin:{...discordLogin,hasSavedSetup:!!state.discordSetup?.clientSecret,clientId:state.discordSetup?.clientId},attention:buildAttentionQueue(state),nativeScreensAvailable:!!hooks.openService,background:hooks.backgroundStatus?.()||{preventSleep:false},startup:hooks.startupStatus?.()||{supported:false,enabled:false}});
        if(req.method==='GET'&&url.pathname==='/api/connection-health')return reply(200,{intervalSeconds:60,retryMaximumSeconds:905,accounts:state.accounts.map(a=>({id:a.id,name:a.name,busy:coordinator.busy.has(a.id),...a.connection})),background:state.background||{preventSleep:false}});
        if(req.method==='GET'&&url.pathname==='/api/capabilities')return reply(200,pcCapabilities);
        if(req.method==='GET'&&url.pathname==='/api/learning-status'){const summary=learningSummary(state);vault.save();return reply(200,summary);}
        if(req.method==='GET'&&url.pathname==='/api/asset'){const input=Object.fromEntries(url.searchParams),asset=assetService.resolve(input),data=vault.assets.read(asset);res.writeHead(200,{'Content-Type':asset.mime,'Content-Length':data.length,'Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(asset.name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);return;}
        if(req.method==='GET'&&url.pathname==='/api/remote-mcp-status')return reply(200,{...remoteMcp.status(),persistentTunnel:persistentTunnel.status(),quickTunnel:{supported:hooks.tunnelSupported===true,running:!!tunnel,...tunnelStatus}});
        if(req.method==='GET'&&url.pathname==='/api/mcp-info')return reply(200,{endpoint:`http://127.0.0.1:${port}/mcp`,token:state.mcpToken});
        if(req.method==='GET'&&url.pathname==='/api/mobile-status')return reply(200,mobile.status());
        if(req.method!=='POST')return reply(405,{error:'POST required'});
        const a=await body(req);if(!a||typeof a!=='object'||Array.isArray(a))throw Error('入力形式が無効です');
        if(url.pathname==='/api/stage-message-action')return reply(200,messageActions.stage(a));
        if(url.pathname==='/api/prepare-message-action')return reply(200,messageActions.prepare(String(a.id||'')));
        if(url.pathname==='/api/approve-message-action')return reply(200,await messageActions.approve(String(a.id||''),String(a.challenge||''),a.explicitConfirmation===true));
        if(url.pathname==='/api/discard-message-action'){messageActions.discard(String(a.id||''));return reply(200,{ok:true});}
        if(url.pathname==='/api/resolve-message-action'){messageActions.resolve(String(a.id||''));return reply(200,{ok:true});}
        if(url.pathname==='/api/read-mode'){
          const account=state.accounts.find(x=>x.id===a.accountId);if(!account||!['never','on-send','always'].includes(a.mode))throw Error('既読設定が無効です');
          if(a.mode!=='never'&&(!adapters[account.adapter]?.markRead||a.explicitConfirmation!==true))throw Error('既読通知を送るモードへの変更を確認してください');
          account.readMode=a.mode;vault.save();return reply(200,{ok:true});
        }
        if(url.pathname==='/api/view-receipt'){
          const account=state.accounts.find(x=>x.id===a.accountId),thread=state.threads.find(t=>t.accountId===a.accountId&&t.id===a.threadId),message=state.messages.find(m=>m.accountId===a.accountId&&m.threadId===a.threadId&&m.id===a.messageId);
          if(!account||!thread||!message)throw Error('会話がありません');return reply(200,await sendReadReceipt(state,adapters,account,thread,message,'opened',()=>vault.save()));
        }
        if(url.pathname==='/api/thread-replies'){await coordinator.replies(String(a.accountId||''),String(a.threadId||''),String(a.messageId||''));return reply(200,{ok:true});}
        if(url.pathname==='/api/thread-members'){await coordinator.members(String(a.accountId||''),String(a.threadId||''));return reply(200,{ok:true});}
        if(url.pathname==='/api/open-link'){if(typeof a.url!=='string'||a.url.length>4096||!hooks.openLink)throw Error('リンクが無効です');const target=new URL(a.url);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw Error('HTTPまたはHTTPSのリンクだけを開けます');await hooks.openLink(target.href);return reply(200,{ok:true});}
        if(url.pathname==='/api/pick-draft-files'&&!a.draftId){a.replyTo=validateQuote(a);a.emailCc=mailCopies(a);}
        const fileAction=await assetService.route(url.pathname,a);if(fileAction!==undefined)return reply(200,fileAction);
        const learned=learningRoute(state,url.pathname,a);if(learned!==undefined){vault.save();return reply(200,learned);}
        if(url.pathname==='/api/persistent-tunnel-config'){if(tunnel||tunnelStatus.pending)await stopTunnel();return reply(200,await persistentTunnel.configure(a));}
        if(url.pathname==='/api/persistent-tunnel-stop')return reply(200,await persistentTunnel.disable());
        if(url.pathname==='/api/start-quick-tunnel'){if(persistentTunnel.status().enabled)throw Error('固定接続を停止してから簡易接続へ切り替えてください');if(a.explicitConfirmation!==true||!hooks.openTunnel||!hooks.tunnelSupported)throw Error('Cloudflareを経由する公開接続を画面で確認してください');if(tunnelStatus.pending||tunnel)throw Error('簡易接続は準備中または起動中です');if(!state.accounts.some(a=>a.aiAllowed))throw Error('先に共有するアカウント・会話を選択してください');void startTunnel();return reply(202,{pending:true});}
        if(url.pathname==='/api/stop-quick-tunnel'){await stopTunnel();return reply(200,{ok:true});}
        if(url.pathname==='/api/remote-mcp-config'){if(persistentTunnel.status().enabled)throw Error('固定接続の設定を使用中です。固定接続欄で変更・停止してください');if(tunnel||tunnelStatus.pending)await stopTunnel();return reply(200,await remoteMcp.configure(a));}
        if(url.pathname==='/api/remote-mcp-consent'){if(typeof a.accept!=='boolean')throw Error('接続の承認を確認してください');remoteMcp.approve(String(a.id||''),a.accept,a.allowDrafts===true);return reply(200,{ok:true});}
        if(url.pathname==='/api/remote-mcp-revoke'){remoteMcp.revoke(String(a.id||''));return reply(200,{ok:true});}
        if(url.pathname==='/api/mail-oauth-login'){
          if(!hooks.mailLogin||!['google','microsoft'].includes(a.provider))throw Error('メールログインを利用できません');if(mailLogin.pending)throw Error('メールの本人認証が進行中です');mailLogin.pending=true;mailLogin.error='';
          void hooks.mailLogin({provider:a.provider,clientId:typeof a.clientId==='string'?a.clientId:undefined,gmailFilters:a.gmailFilters===true}).then(account=>{const existing=state.accounts.find(x=>x.adapter==='imap'&&x.config.user?.toLowerCase()===account.config.user.toLowerCase()&&x.config.host===account.config.host);if(existing){existing.config={...existing.config,...account.config};delete existing.config.password;delete existing.config.smtpPassword;}else state.accounts.push(account);vault.save();void sync();}).catch(()=>{mailLogin.error='メール認証は完了していません。OAuthのアプリ登録・許可・公式画面を確認してください。既存の接続は保持しています。';}).finally(()=>{mailLogin.pending=false;});return reply(202,{pending:true});
        }
        if(url.pathname==='/api/gmail-filter-list'){const account=state.accounts.find(x=>x.id===a.accountId&&x.adapter==='imap');if(!account)throw Error('メール接続がありません');return reply(200,{supported:gmailFilters.supported(account),operations:gmailFilters.rows(account.id)});}
        if(url.pathname==='/api/gmail-filter-stage')return reply(200,gmailFilters.stage(a));
        if(url.pathname==='/api/gmail-filter-prepare')return reply(200,gmailFilters.prepare(a.id));
        if(url.pathname==='/api/gmail-filter-approve')return reply(200,await gmailFilters.approve(a.id,a.challenge,a.explicitConfirmation===true));
        if(url.pathname==='/api/gmail-filter-reconcile')return reply(200,await gmailFilters.reconcile(a.id));
        if(url.pathname==='/api/gmail-filter-discard'){gmailFilters.discard(a.id);return reply(200,{ok:true});}
        if(url.pathname==='/api/mail-folders'){
          const account=state.accounts.find(x=>x.id===a.accountId&&x.adapter==='imap');if(!account)throw Error('メール接続がありません');const adapter=adapters.imap as ImapAdapter;if(coordinator.busy.has(account.id))throw Error('メールを同期中です');coordinator.busy.add(account.id);
          try{const folders=await adapter.listFolders(account);if(!state.accounts.includes(account))throw Error('メール接続が削除されました');if(a.folders!==undefined){if(!Array.isArray(a.folders)||!a.folders.length||a.folders.length>10||a.folders.some((p:any)=>typeof p!=='string'||!folders.some(f=>f.path===p)))throw Error('取得するフォルダーを1〜10個選択してください');account.config.mailFolders=JSON.stringify([...new Set(a.folders)]);account.config.imapHistoryComplete='false';}vault.save();return reply(200,{folders});}finally{coordinator.busy.delete(account.id);}
        }
        if(url.pathname==='/api/discord-rpc-login'){
          if(a.explicitConfirmation!==true)throw Error('Discordの公式PC連携の権限要求を確認してください');if(discordLogin.pending)throw Error('Discordの本人承認が進行中です');
          if(typeof a.clientId!=='string'||typeof a.clientSecret!=='string'||typeof a.channels!=='string'||a.redirectUri!==undefined&&typeof a.redirectUri!=='string')throw Error('Discordアプリの設定を確認してください');
          if(!a.clientSecret&&state.discordSetup&&state.discordSetup.clientId===a.clientId)a.clientSecret=state.discordSetup.clientSecret;
          if(!/^\d{15,22}$/.test(a.clientId)||!a.clientSecret||a.clientSecret.length>500)throw Error('Discord開発アプリのApplication IDとClient Secretを入力してください');
          state.discordSetup={clientId:a.clientId,clientSecret:a.clientSecret,channels:a.channels,redirectUri:a.redirectUri||undefined};vault.save();
          discordLogin.pending=true;discordLogin.error='';discordLogin.diagnostic=undefined;void discordRpc.login({...state.discordSetup}).then(account=>{const existing=state.accounts.find(x=>x.adapter==='discord'&&x.config.mode==='rpc'&&x.config.viewerId===account.config.viewerId);if(existing){existing.config=account.config;delete existing.error;delete existing.errorCode;}else state.accounts.push(account);vault.save();void sync();}).catch(error=>{discordLogin.error=error instanceof DiscordRpcError?error.message:'Discordの公式PC連携を完了できませんでした';discordLogin.diagnostic=error instanceof DiscordRpcError?error.diagnostic():{stage:'connection',code:'connection_failed'};}).finally(()=>{discordLogin.pending=false;a.clientSecret='';});return reply(202,{pending:true});
        }
        if(url.pathname==='/api/discord-rpc-forget-setup'){if(discordLogin.pending)throw Error('本人認証の完了を待ってください');delete state.discordSetup;vault.save();return reply(200,{ok:true});}
        if(url.pathname==='/api/discord-rpc-channels'){
          const account=state.accounts.find(x=>x.id===a.accountId&&x.adapter==='discord'&&x.config.mode==='rpc');if(!account||typeof a.channels!=='string')throw Error('Discord接続がありません');if(coordinator.busy.has(account.id))throw Error('Discordを同期中です');account.config={...account.config,channels:discordRpc.channels(a.channels).join(',')};vault.save();return reply(200,{ok:true});
        }
        if(url.pathname==='/api/messenger-encrypted-enable'){if(!hooks.messengerEncrypted)throw Error('暗号化連携を利用できません');return reply(200,await hooks.messengerEncrypted.enable(String(a.accountId||''),a.explicitConfirmation===true));}
        if(url.pathname==='/api/messenger-encrypted-disable'){if(!hooks.messengerEncrypted)throw Error('暗号化連携を利用できません');return reply(200,await hooks.messengerEncrypted.disable(String(a.accountId||'')));}
        if(url.pathname==='/api/messenger-recover-history'){if(!hooks.messengerEncrypted||typeof a.pin!=='string')throw Error('履歴復元PINをこのアプリ内に入力してください');try{return reply(200,await hooks.messengerEncrypted.recover(String(a.accountId||''),a.pin,a.explicitConfirmation===true));}catch(error){const remaining=error instanceof Error&&(error as any).attemptsRemaining;return reply(400,{error:(error instanceof Error?error.message:'履歴復元を完了できませんでした')+(Number.isInteger(remaining)?'。残り試行回数：'+remaining:'')});}finally{a.pin='';}}
        if(url.pathname==='/api/instagram-login'){
          beginInstagramLogin();
          return reply(202,{pending:true});
        }
        if(url.pathname==='/api/service-login'){if(!['slack','messenger'].includes(a.service))throw Error('Invalid service');beginServiceLogin(a.service);return reply(202,{pending:true});}
        if(url.pathname==='/api/line-login'){beginLineLogin();return reply(202,{pending:true});}
        if(url.pathname==='/api/connect'){
          if(!['imap','slack','sendy','matrix','discord'].includes(a.adapter))throw Error('未対応の接続方式です');
          if(typeof a.name!=='string'||!a.name.trim()||a.name.length>100)throw Error('接続名を入力してください');
          if(!a.config||typeof a.config!=='object'||Object.values(a.config).some(v=>typeof v!=='string'||v.length>10000))throw Error('接続設定が無効です');
          if(a.adapter==='imap'&&(!a.config.host||!a.config.user||!a.config.password))throw Error('IMAPサーバー・メールアドレス・アプリパスワードを入力してください');
          if(a.adapter==='imap'&&(!Number.isInteger(Number(a.config.port||993))||Number(a.config.port||993)<1||Number(a.config.port||993)>65535))throw Error('ポート番号が無効です');
          if(a.adapter==='slack'&&!a.config.token)throw Error('Slackトークンを入力してください');
          if(a.adapter==='discord'&&a.config.mode==='user')throw Error('個人DMの統合取得は未対応です。元のDiscord画面から操作できます');
          if(a.adapter==='discord'&&(!a.config.token||!a.config.channels))throw Error('Discordのトークンと対象チャンネルを入力してください');
          if(a.adapter==='matrix'&&(!a.config.homeserver||!a.config.token||!a.config.userId))throw Error('Messenger用Matrixブリッジの接続設定を入力してください');
          if(a.adapter==='sendy'&&(!a.config.token||!a.config.remoteAccountId||!services.includes(a.service)))throw Error('Sendyのキー・接続番号・サービスを入力してください');
          const account:Account={id:randomUUID(),service:a.adapter==='imap'?'email':a.adapter==='slack'?'slack':a.adapter==='matrix'?'messenger':a.adapter==='discord'?'discord':a.service,name:a.adapter==='imap'&&a.name.trim()==='Gmail'?'Gmail · '+a.config.user:a.name.trim(),adapter:a.adapter,config:a.config,aiAllowed:false};
          const existing=account.adapter==='imap'?state.accounts.find(x=>x.adapter==='imap'&&x.config.host===account.config.host&&x.config.user?.toLowerCase()===account.config.user.toLowerCase()):undefined;if(existing){existing.config={...existing.config,...account.config};for(const name of Object.keys(existing.config))if(name.startsWith('oauth'))delete existing.config[name];delete existing.error;delete existing.errorCode;}else state.accounts.push(account);vault.save();void sync();return reply(200,{id:existing?.id||account.id});
        }
        if(url.pathname==='/api/open-service'){
          if(!services.includes(a.service)||!hooks.openService)throw Error('サービス画面を利用できません');
          if(a.accountId&&!state.accounts.some(x=>x.id===a.accountId&&x.service===a.service))throw Error('接続アカウントが一致しません');
          if(a.threadId!==undefined&&(typeof a.threadId!=='string'||!state.threads.some(t=>t.accountId===a.accountId&&t.id===a.threadId)))throw Error('会話が一致しません');
          if(a.acknowledgeReadEffects!==true)throw Error('元の画面での既読動作を確認してください');
          if(a.bounds&&(!['x','y','width','height'].every(k=>Number.isFinite(a.bounds[k])&&a.bounds[k]>=0&&a.bounds[k]<20000)))throw Error('画面サイズが無効です');await hooks.openService(a.service,a.accountId,a.bounds,a.threadId);return reply(200,{opened:true});
        }
        if(url.pathname==='/api/hide-service'){hooks.hideService?.();return reply(200,{ok:true});}
        if(url.pathname==='/api/reload-service'){hooks.reloadService?.();return reply(200,{ok:true});}
        if(url.pathname==='/api/service-bounds'){if(!a.bounds||!['x','y','width','height'].every(k=>Number.isFinite(a.bounds[k])&&a.bounds[k]>=0&&a.bounds[k]<20000))throw Error('画面サイズが無効です');hooks.serviceBounds?.(a.bounds);return reply(200,{ok:true});}
        if(url.pathname==='/api/rename-account'){
          const account=state.accounts.find(x=>x.id===a.accountId);if(!account)throw Error('アカウントがありません');
          if(typeof a.name!=='string'||!a.name.trim()||a.name.length>100)throw Error('表示名は1〜100文字で入力してください');
          account.name=a.name.trim();vault.save();return reply(200,{ok:true});
        }
        if(url.pathname==='/api/attention-feedback'){
          const t=state.threads.find(t=>t.accountId===a.accountId&&t.id===a.threadId);if(!t)throw Error('会話がありません');
          if(![-1,0,1].includes(a.direction))throw Error('優先度の操作が無効です');
          if(a.direction===0)t.priorityFeedback=0;
          else{
            const item=buildAttentionQueue(state).find(i=>i.accountId===a.accountId&&i.threadId===a.threadId);if(!item)throw Error('優先度を調整できる連絡がありません');
            const levels=['low','medium','high'],current=levels.indexOf(item.level),next=Math.max(0,Math.min(2,current+a.direction));
            if(a.expectedLevel!==undefined&&a.expectedLevel!==item.level)throw Error('推定の優先度が更新されました。現在の表示を確認して、もう一度操作してください');
            if(next!==current)t.priorityFeedback=next-levels.indexOf(item.autoLevel);
          }
          if(a.direction){const latest=state.messages.filter(m=>m.accountId===t.accountId&&m.threadId===t.id&&!m.isMe&&!m.deleted).sort((x,y)=>y.ts-x.ts)[0];observeLearning(state,a.direction>0?'priority_up':'priority_down',latest);}vault.save();return reply(200,{ok:true});
        }
        if(url.pathname==='/api/attention-seen'){
          const t=state.threads.find(t=>t.accountId===a.accountId&&t.id===a.threadId);
          const message=state.messages.find(m=>m.accountId===a.accountId&&m.threadId===a.threadId&&m.id===a.messageId&&!m.isMe);
          if(t&&!message&&a.messageId===null&&a.throughTimestamp===t.updatedAt&&(t.bodyUnavailable||t.sourceUnread===true)&&!state.messages.some(m=>m.accountId===t.accountId&&m.threadId===t.id&&!m.isMe)){
            t.localSeenAt=t.updatedAt;t.localSeenMessageId='@thread';vault.save();return reply(200,{ok:true,remoteReadReceiptSent:false});
          }
          if(!t||!message)throw Error('対象の連絡がありません');
          if(message.ts>=(t.localSeenAt||0)){t.localSeenAt=message.ts;t.localSeenMessageId=message.id;}vault.save();return reply(200,{ok:true,remoteReadReceiptSent:false});
        }
        if(url.pathname==='/api/self-email-test')return reply(200,prepareSelfMailTest(String(a.accountId||'')));
        if(url.pathname==='/api/new-email-draft'){
          const account=state.accounts.find(x=>x.id===a.accountId&&x.adapter==='imap');if(!account)throw Error('メールの接続を選んでください');
          if(typeof a.recipient!=='string'||a.recipient.length>254||!/^[^\s@<>,;:"()]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(a.recipient)||/[\r\n]/.test(a.recipient))throw Error('宛先メールアドレスを確認してください');
          if(typeof a.subject!=='string'||!a.subject.trim()||a.subject.length>300||/[\r\n]/.test(a.subject))throw Error('件名を1〜300文字で入力してください');
          if(typeof a.text!=='string'||!a.text.trim()||a.text.length>10000)throw Error('本文を1〜10000文字で入力してください');
          const emailCc=mailAddresses(a.cc),emailBcc=mailAddresses(a.bcc);const threadId='compose:'+randomUUID();state.threads.push({id:threadId,accountId:account.id,title:a.subject.trim(),updatedAt:Date.now(),isGroup:false,members:[a.recipient],membersComplete:true,replyAddress:a.recipient,composeMode:'new'});
          const draft={id:randomUUID(),accountId:account.id,threadId,text:a.text,emailCc,emailBcc,createdAt:Date.now(),status:'pending' as const};state.drafts.push(draft);vault.save();return reply(200,{id:draft.id,threadId,sent:false});
        }
        if(url.pathname==='/api/fill-history-gap'){await coordinator.fillGap(String(a.accountId||''),String(a.threadId||''));return reply(200,{ok:true});}
        if(url.pathname==='/api/thread-history'){await coordinator.threadHistory(String(a.accountId||''),String(a.threadId||''),typeof a.before==='string'?a.before:undefined);return reply(200,{ok:true});}
        if(url.pathname==='/api/history'){await coordinator.history(String(a.accountId||''));return reply(200,{ok:true});}
        if(url.pathname==='/api/sync'){void sync();return reply(202,{started:true});}
        if(url.pathname==='/api/mobile-pair'){
          if(!mobile.addresses().includes(String(a.host||'')))throw Error('このPCの接続先アドレスを選んでください');
          const paired=await mobile.pair(Array.isArray(a.accounts)?a.accounts:[],String(a.name||'Android'),a.sendAllowed===true);
          const pairingText=JSON.stringify({version:1,endpoint:`https://${a.host}:${paired.port}`,token:paired.token,fingerprint:paired.fingerprint});
          const uri='relaydesk://pair?data='+Buffer.from(pairingText).toString('base64url');
          return reply(200,{...paired,pairingText,qrDataUrl:await QRCode.toDataURL(uri,{width:300,margin:2})});
        }
        if(url.pathname==='/api/mobile-stop'){await mobile.stop(true);return reply(200,{ok:true});}
        if(url.pathname==='/api/mobile-revoke'){mobile.revoke(String(a.deviceId||''));return reply(200,{ok:true});}
        if(url.pathname==='/api/update-draft'||url.pathname==='/api/discard-draft'){
          const draft=state.drafts.find(d=>d.id===a.draftId&&d.status==='pending');if(!draft)throw Error('編集・取り消しできる承認待ちの返信案がありません');
          if(url.pathname==='/api/update-draft'){if(typeof a.text!=='string'||(!a.text.trim()&&!draft.fileIds?.length)||a.text.length>10000)throw Error('本文または添付が必要です。本文は10000文字までです');draft.text=a.text;}else{const assets=(state.assets||[]).filter(f=>f.draftId===draft.id);state.assets=(state.assets||[]).filter(f=>f.draftId!==draft.id);state.drafts=state.drafts.filter(d=>d!==draft);vault.save();for(const asset of assets)vault.assets.remove(asset.id);}
          vault.save();return reply(200,{ok:true,remoteChanged:false});
        }
        if(url.pathname==='/api/prepare-send')return reply(200,outbox.prepare(String(a.draftId||'')));
        if(url.pathname==='/api/approve-send')return reply(200,await outbox.approve(String(a.draftId||''),String(a.challenge||''),a.explicitConfirmation===true));
        if(url.pathname==='/api/grant'){
          const account=state.accounts.find(x=>x.id===a.accountId);if(!account)throw Error('アカウントがありません');
          if(a.scope!==undefined&&!['all','selected'].includes(a.scope))throw Error('共有範囲が無効です');
          if(a.threadIds!==undefined&&(!Array.isArray(a.threadIds)||a.threadIds.length>10000||a.threadIds.some((id:unknown)=>typeof id!=='string'||!state.threads.some(t=>t.accountId===account.id&&t.id===id))))throw Error('共有する会話が見つかりません');
          account.aiAllowed=a.allowed===true;if(a.scope!==undefined)account.aiScope=a.scope;if(a.threadIds!==undefined)account.aiThreadIds=[...new Set<string>(a.threadIds)];vault.save();return reply(200,{ok:true});
        }
        if(url.pathname==='/api/quit-app'){if(!hooks.quit)throw Error('通知領域の終了メニューを使用してください');reply(200,{quitting:true});setImmediate(hooks.quit);return;}
        if(url.pathname==='/api/background-settings'){if(typeof a.preventSleep!=='boolean'||!hooks.setPreventSleep)throw Error('バックグラウンド設定が無効です');hooks.setPreventSleep(a.preventSleep);state.background={...state.background,preventSleep:a.preventSleep};vault.save();return reply(200,{ok:true});}
        if(url.pathname==='/api/startup-settings'){if(typeof a.enabled!=='boolean'||!hooks.setStartup)throw Error('自動起動の設定を利用できません');hooks.setStartup(a.enabled);return reply(200,{ok:true});}
        if(url.pathname==='/api/test-notification'){if(!hooks.testNotification)throw Error('この環境では通知をテストできません');hooks.testNotification();return reply(200,{requested:true});}
        if(url.pathname==='/api/notification-settings'){if(typeof a.enabled!=='boolean'||!['all','medium','high'].includes(a.minimum))throw Error('通知設定が無効です');state.desktopNotifications={enabled:a.enabled,minimum:a.minimum};vault.save();hooks.notificationSettingsChanged?.();return reply(200,{ok:true});}
        if(url.pathname==='/api/mcp-settings'){state.draftAllowed=a.draftAllowed===true;vault.save();return reply(200,{ok:true});}
        if(url.pathname==='/api/rotate-key'){state.mcpToken=randomBytes(32).toString('hex');vault.save();return reply(200,{ok:true});}
        if(url.pathname==='/api/thread'){const t=state.threads.find(t=>t.accountId===a.accountId&&t.id===a.threadId);if(!t)throw Error('会話がありません');if(typeof a.pinned==='boolean')t.pinned=a.pinned;if(typeof a.folder==='string')t.folder=a.folder.slice(0,100);if(typeof a.priority==='number')t.priority=Math.max(0,Math.min(2,Math.floor(a.priority)));vault.save();return reply(200,{ok:true});}
        if(url.pathname==='/api/composer'){
          if(!state.threads.some(t=>t.accountId===a.accountId&&t.id===a.threadId))throw Error('会話がありません');
          if(typeof a.text!=='string'||a.text.length>10000)throw Error('返信の入力は10000文字までです');
          state.composerDrafts=(state.composerDrafts||[]).filter(d=>d.accountId!==a.accountId||d.threadId!==a.threadId);
          const replyTo=validateQuote(a);if(a.text||replyTo)state.composerDrafts.push({accountId:a.accountId,threadId:a.threadId,text:a.text,replyTo,replyAll:a.replyAll===true,updatedAt:Date.now()});
          vault.save();return reply(200,{saved:true,sent:false});
        }
        if(url.pathname==='/api/draft'){if(!state.threads.some(t=>t.accountId===a.accountId&&t.id===a.threadId))throw Error('会話がありません');if(typeof a.text!=='string'||!a.text.trim()||a.text.length>10000)throw Error('返信案は1〜10000文字です');const draft={id:randomUUID(),accountId:a.accountId,threadId:a.threadId,text:a.text,replyTo:validateQuote(a),emailCc:mailCopies(a),createdAt:Date.now(),status:'pending' as const};state.drafts.push(draft);state.composerDrafts=(state.composerDrafts||[]).filter(d=>d.accountId!==a.accountId||d.threadId!==a.threadId);vault.save();return reply(200,{id:draft.id});}
        if(url.pathname==='/api/remove-account'){if(gmailFilters.inFlight(a.accountId)||state.gmailFilters?.some(r=>r.accountId===a.accountId&&r.status==='running'))throw Error('Gmailの設定操作中は接続を削除できません');if(state.drafts.some(d=>d.accountId===a.accountId&&d.status==='sending')||state.operations?.some(o=>o.accountId===a.accountId&&o.status==='running'))throw Error('送信中は接続を削除できません。結果が確定してから操作してください');const removedAccount=state.accounts.find(x=>x.id===a.accountId);if(removedAccount?.adapter==='discord'&&state.discordSetup?.clientId===removedAccount.config.rpcClientId)delete state.discordSetup;const ownedAssets=(state.assets||[]).filter(f=>f.accountId===a.accountId);state.assets=(state.assets||[]).filter(f=>f.accountId!==a.accountId);state.gmailFilters=state.gmailFilters?.filter(r=>r.accountId!==a.accountId);state.accounts=state.accounts.filter(x=>x.id!==a.accountId);state.threads=state.threads.filter(x=>x.accountId!==a.accountId);state.messages=state.messages.filter(x=>x.accountId!==a.accountId);state.drafts=state.drafts.filter(x=>x.accountId!==a.accountId);state.composerDrafts=(state.composerDrafts||[]).filter(x=>x.accountId!==a.accountId);state.syncGaps=state.syncGaps?.filter(g=>g.accountId!==a.accountId);state.operations=state.operations?.filter(o=>o.accountId!==a.accountId);pruneLearning(state);vault.save();await hooks.forget?.(a.accountId);for(const asset of ownedAssets)vault.assets.remove(asset.id);return reply(200,{ok:true});}
        return reply(404,{error:'Not found'});
      }
      const assets:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript'],'/draft-editor.js':['draft-editor.js','text/javascript'],'/attachments.js':['attachments.js','text/javascript'],'/message-controls.js':['message-controls.js','text/javascript'],'/gmail-filters.js':['gmail-filters.js','text/javascript'],'/mail-settings.js':['mail-settings.js','text/javascript'],'/capabilities.js':['capabilities.js','text/javascript'],'/discord-settings.js':['discord-settings.js','text/javascript'],'/messenger-encrypted.js':['messenger-encrypted.js','text/javascript'],'/composer.js':['composer.js','text/javascript'],'/ai.js':['ai.js','text/javascript'],'/persistent-tunnel.js':['persistent-tunnel.js','text/javascript'],'/remote-mcp.js':['remote-mcp.js','text/javascript'],'/desktop-settings.js':['desktop-settings.js','text/javascript'],'/learning.js':['learning.js','text/javascript'],'/mobile.js':['mobile.js','text/javascript'],'/attention.js':['attention.js','text/javascript'],'/apps.js':['apps.js','text/javascript'],'/style.css':['style.css','text/css']};
      const asset=assets[url.pathname];if(req.method!=='GET'||!asset)return reply(404,{error:'Not found'});
      res.writeHead(200,{'Content-Type':asset[1],'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(readFileSync(join(uiDir,asset[0])));
    }catch(e){reply(400,{error:e instanceof SyntaxError?'入力形式が無効です':e instanceof Error&& !/password|token|Bearer/i.test(e.message)?e.message:'処理できませんでした'});}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>{port=(server.address() as any).port;resolve();}));
  await mobile.restore();await remoteMcp.restore();void persistentTunnel.restore();
  const timer=setInterval(()=>void coordinator.sync(),10000);timer.unref();
  return{server,port,session,sync,prepareSelfMailTest,beginInstagramLogin,beginLineLogin,beginServiceLogin,close:async()=>{coordinator.stop();clearInterval(timer);await mobile.stop();await persistentTunnel.close();if(tunnel||tunnelStatus.pending)await stopTunnel();await remoteMcp.close();await new Promise<void>(r=>server.close(()=>r()));}};
}

