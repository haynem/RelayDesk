import {createConnection,type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {Account,Batch,Message,Thread} from './model.js';

// OAuth-scoped desktop RPC only. Never read Discord's login token or session store.
export type DiscordSetup={clientId:string;clientSecret:string;channels:string;redirectUri?:string};
export type DiscordDiagnostic={stage:string;code:string;providerCode?:string;status?:number};
export class DiscordRpcError extends Error {
  readonly definitelyNotSent=true;
  constructor(readonly code:string,readonly stage='setup',readonly providerCode?:string,readonly status?:number){
    super(({client_unavailable:'DiscordのPCアプリとの接続を確認できません',scope_denied:'Discordから必要な閲覧権限が返されていません',identity_mismatch:'Discordのログイン本人が接続済みアカウントと一致しません',invalid_client:'DiscordがApplication IDとClient Secretの組み合わせを認証できませんでした',invalid_grant:'Discordの認証コードを交換できませんでした。コードの期限・一度限りの利用・Redirect URIを確認してください',invalid_redirect:'Discordに登録したRedirect URIと認証要求が一致しません',invalid_scope:'Discordが要求したOAuth権限を受け付けませんでした',access_denied:'Discordで認証が許可されませんでした',rpc_rejected:'DiscordのPCアプリが連携要求を受け付けませんでした',rpc_timeout:'DiscordのPCアプリから応答がありません',invalid_oauth:'Discordの認証応答を確認できません'} as Record<string,string>)[code]||'Discordの公式PC連携を完了できませんでした');
  }
  diagnostic():DiscordDiagnostic{return{stage:this.stage,code:this.code,providerCode:this.providerCode,status:this.status};}
}
type Pending={resolve:(data:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;cmd:string};
class RpcPipe {
  private socket?:Socket;private bytes=Buffer.alloc(0);private pending=new Map<string,Pending>();private stopped=false;
  private readyResolve?:()=>void;private readyReject?:(error:Error)=>void;
  async open(clientId:string){
    for(let n=0;n<10;n++){
      const path=process.platform==='win32'?`\\\\?\\pipe\\discord-ipc-${n}`:join(process.env.XDG_RUNTIME_DIR||process.env.TMPDIR||process.env.TMP||process.env.TEMP||tmpdir(),`discord-ipc-${n}`);
      const socket=createConnection(path);
      const connected=await new Promise<boolean>(resolve=>{const timer=setTimeout(()=>{socket.destroy();resolve(false);},700);socket.once('connect',()=>{clearTimeout(timer);resolve(true);});socket.once('error',()=>{clearTimeout(timer);resolve(false);});});
      if(!connected){socket.destroy();continue;}this.socket=socket;
      socket.on('data',chunk=>{try{this.consume(chunk);}catch{this.close();}});socket.on('error',()=>this.close());socket.on('close',()=>this.close());
      const ready=new Promise<void>((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
      const timer=setTimeout(()=>this.close(),10000);this.frame(0,{v:1,client_id:clientId});try{await ready;}finally{clearTimeout(timer);}return;
    }
    throw new DiscordRpcError('client_unavailable');
  }
  private frame(opcode:number,value:unknown){if(!this.socket||this.stopped)throw new DiscordRpcError('client_unavailable');const body=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(8);header.writeUInt32LE(opcode);header.writeUInt32LE(body.length,4);this.socket.write(Buffer.concat([header,body]));}
  private consume(chunk:Buffer){
    if(this.bytes.length+chunk.length>16*1024*1024)throw Error('frame_limit');this.bytes=Buffer.concat([this.bytes,chunk]);
    while(this.bytes.length>=8){const opcode=this.bytes.readUInt32LE(),length=this.bytes.readUInt32LE(4);if(length>16*1024*1024)throw Error('frame_limit');if(this.bytes.length<length+8)return;const data=JSON.parse(this.bytes.subarray(8,8+length).toString('utf8'));this.bytes=this.bytes.subarray(8+length);
      if(opcode===3){this.frame(4,data);continue;}if(opcode===2){this.close();return;}if(opcode!==1)continue;
      if(data.evt==='READY'){this.readyResolve?.();this.readyResolve=undefined;this.readyReject=undefined;continue;}
      const pending=this.pending.get(data.nonce);if(!pending)continue;clearTimeout(pending.timer);this.pending.delete(data.nonce);
      if(data.evt==='ERROR'){const stage=pending.cmd==='AUTHORIZE'?'authorize':pending.cmd==='AUTHENTICATE'?'authenticate':'read',code=Number(data.data?.code);pending.reject(new DiscordRpcError('rpc_rejected',stage,Number.isInteger(code)&&code>=0&&code<100000?'RPC '+code:undefined));}else pending.resolve(data.data);
    }
  }
  request(cmd:string,args:Record<string,unknown>,timeout=25000):Promise<any>{const nonce=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(nonce);reject(new DiscordRpcError('rpc_timeout',cmd==='AUTHORIZE'?'authorize':cmd==='AUTHENTICATE'?'authenticate':'read'));},timeout);this.pending.set(nonce,{resolve,reject,timer,cmd});try{this.frame(1,{cmd,args,nonce});}catch(error){clearTimeout(timer);this.pending.delete(nonce);reject(error);}});}
  close(){if(this.stopped)return;this.stopped=true;this.socket?.destroy();this.readyReject?.(new DiscordRpcError('client_unavailable'));this.readyReject=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new DiscordRpcError('client_unavailable'));}this.pending.clear();this.bytes=Buffer.alloc(0);}
}
const scopes=['identify','rpc','messages.read'];
async function tokenRequest(config:Record<string,string>,grant:Record<string,string>){
  const response=await fetch('https://discord.com/api/oauth2/token',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.rpcClientId,client_secret:config.rpcClientSecret,...grant}),signal:AbortSignal.timeout(20000)});
  let value:any;try{value=await response.json();}catch{throw new DiscordRpcError('invalid_oauth','token',undefined,response.status);}
  if(!response.ok){const code=['invalid_client','invalid_grant','invalid_scope','access_denied','invalid_request','unauthorized_client','unsupported_grant_type','server_error','temporarily_unavailable'].includes(value?.error)?value.error:'token_rejected';throw new DiscordRpcError(code,'token',code,response.status);}
  if(typeof value.access_token!=='string'||typeof value.refresh_token!=='string'||!Number.isFinite(value.expires_in)||value.expires_in<=0)throw new DiscordRpcError('invalid_oauth','token');
  const granted=String(value.scope||'').split(' ');if(value.token_type?.toLowerCase()!=='bearer'||scopes.some(scope=>!granted.includes(scope)))throw new DiscordRpcError('scope_denied','token');return{rpcAccessToken:value.access_token,rpcRefreshToken:value.refresh_token,rpcExpiresAt:String(Date.now()+value.expires_in*1000)};
}
export class DiscordPersonalRpc {
  async login(input:DiscordSetup):Promise<Account>{
    if(!/^\d{15,22}$/.test(input.clientId)||!input.clientSecret||input.clientSecret.length>500)throw new DiscordRpcError('invalid_app');
    const channels=this.channels(input.channels),config:Record<string,string>={mode:'rpc',rpcClientId:input.clientId,rpcClientSecret:input.clientSecret,channels:channels.join(',')};
    if(input.redirectUri){const url=new URL(input.redirectUri);if(url.origin!=='http://127.0.0.1'||url.username||url.password||url.search||url.hash)throw new DiscordRpcError('invalid_redirect');config.rpcRedirectUri=url.href;}
    const pipe=new RpcPipe();try{await pipe.open(input.clientId);const authorized=await pipe.request('AUTHORIZE',{client_id:input.clientId,scopes},120000);if(typeof authorized.code!=='string')throw new DiscordRpcError('scope_denied');Object.assign(config,await tokenRequest(config,{grant_type:'authorization_code',code:authorized.code,...(config.rpcRedirectUri?{redirect_uri:config.rpcRedirectUri}:{})}));const me=await pipe.request('AUTHENTICATE',{access_token:config.rpcAccessToken});this.identity(me);config.viewerId=me.user.id;return{id:randomUUID(),service:'discord',adapter:'discord',name:'Discord · '+(me.user.global_name||me.user.username||me.user.id),config,aiAllowed:false};}finally{pipe.close();}
  }
  channels(value:string){const ids=[...new Set(value.split(/[\s,]+/).filter(Boolean))];if(ids.length>200||ids.some(id=>!/^\d{15,22}$/.test(id)))throw new DiscordRpcError('invalid_channels');return ids;}
  private identity(value:any,expected?:string){if(!value?.user||typeof value.user.id!=='string'||expected&&value.user.id!==expected)throw new DiscordRpcError('identity_mismatch');if(!Array.isArray(value.scopes)||scopes.some(scope=>!value.scopes.includes(scope)))throw new DiscordRpcError('scope_denied','authenticate');}
  private async authenticated<T>(account:Account,work:(pipe:RpcPipe)=>Promise<T>){const pipe=new RpcPipe();try{await pipe.open(account.config.rpcClientId);if(Number(account.config.rpcExpiresAt)<Date.now()+60000)Object.assign(account.config,await tokenRequest(account.config,{grant_type:'refresh_token',refresh_token:account.config.rpcRefreshToken}));const auth=await pipe.request('AUTHENTICATE',{access_token:account.config.rpcAccessToken});this.identity(auth,account.config.viewerId);return await work(pipe);}finally{pipe.close();}}
  async sync(account:Account):Promise<Batch>{return this.authenticated(account,async pipe=>{const batch:Batch={threads:[],messages:[]};let ids=this.channels(account.config.channels||''),discovered=false,total=ids.length;
    if(!ids.length){
      // discordjs/RPC getChannels accepts an omitted guild ID. Ask the authorized
      // local client; never fall back to user-token REST or claim server completeness.
      const listed=await pipe.request('GET_CHANNELS',{});if(!Array.isArray(listed?.channels))throw new DiscordRpcError('invalid_channel_list','read');
      const all=[...new Set<string>(listed.channels.filter((c:any)=>[1,3].includes(c.type)&&typeof c.id==='string'&&/^\d{15,22}$/.test(c.id)).map((c:any)=>c.id))].sort((a,b)=>a.length-b.length||a.localeCompare(b));total=all.length;
      const offset=Math.max(0,Number(account.config.rpcDmOffset)||0),start=offset<all.length?offset:0;ids=all.slice(start,start+200);account.config.rpcDmOffset=String(start+ids.length>=all.length?0:start+ids.length);discovered=true;
    }
    for(const id of ids){const channel=await pipe.request('GET_CHANNEL',{channel_id:id});if(String(channel.id)!==id)throw new DiscordRpcError('channel_mismatch');const messages=(channel.messages||[]).map((m:any)=>this.message(account,id,m));batch.messages.push(...messages);const people=channel.recipients||[];batch.threads.push({id,accountId:account.id,title:channel.name||people.map((p:any)=>p.global_name||p.username).join('、')||'Discordの会話',isGroup:channel.type!==1,updatedAt:Math.max(0,...messages.map((m:Message)=>m.ts)),members:people.map((p:any)=>p.global_name||p.username||p.id),membersComplete:false});}batch.warning=(ids.length?(discovered?'DiscordのPCアプリが返したDM一覧'+total+'件のうち'+ids.length+'件から、PC内で取得済みの本文を取り込みました。':'指定した会話からPC内で取得済みの本文を取り込みました。'):'本人認証は完了していますが、PC連携から取得できたDM一覧は0件です。')+'サーバー上の全DM・全履歴の網羅と、本人アカウントでの送信はまだ完成していません。';return batch;});}
  private message(account:Account,threadId:string,raw:any):Message{const m=raw.message||raw;if(typeof m.id!=='string'||!m.author?.id||m.channel_id&&m.channel_id!==threadId)throw new DiscordRpcError('invalid_message');return{id:m.id,threadId,accountId:account.id,sender:m.author.id===account.config.viewerId?'自分':m.author.global_name||m.author.username||m.author.id,senderId:m.author.id,isMe:m.author.id===account.config.viewerId,text:String(m.content||''),ts:Date.parse(m.timestamp)||0,editedAt:m.edited_timestamp?Date.parse(m.edited_timestamp):undefined,replyTo:m.message_reference?.message_id,attachments:(m.attachments||[]).map((f:any)=>({name:String(f.filename||'添付'),kind:String(f.content_type||'application/octet-stream'),size:Number(f.size)||undefined,url:typeof f.url==='string'?f.url:undefined,remoteId:f.id})),reactions:(m.reactions||[]).map((r:any)=>({name:r.emoji?.name+(r.emoji?.id?':'+r.emoji.id:''),count:r.count,mine:!!r.me}))};}
  async refreshThread(account:Account,thread:Thread){if(!this.channels(account.config.channels).includes(thread.id))throw new DiscordRpcError('channel_mismatch');return this.sync({...account,config:{...account.config,channels:thread.id}});}
}
