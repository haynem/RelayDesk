import {createServer,type Server} from 'node:https';
import {createHash,randomBytes,randomUUID,X509Certificate,timingSafeEqual} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {generate} from 'selfsigned';
import type {State} from './model.js';
import type {Outbox} from './outbox.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export class MobileGateway{
  private server:Server|null=null;private port=0;private error='';
  constructor(private state:State,private save:()=>void,private outbox?:Outbox){}
  addresses(){return [...new Set(Object.values(networkInterfaces()).flatMap(list=>(list||[]).filter(a=>a.family==='IPv4'&&!a.internal).map(a=>a.address)))];}
  devices(){return(this.state.mobileDevices||[]).map(({tokenHash,...d})=>d);}
  revoke(id:string){const d=this.state.mobileDevices?.find(d=>d.id===id);if(d)d.revoked=true;this.save();}
  async pair(accounts:string[],name:string,sendAllowed=false){
    const allowed=accounts.filter(id=>this.state.accounts.some(a=>a.id===id));
    if(!allowed.length)throw Error('スマートフォンに共有するアカウントを選んでください');
    await this.start();const token=randomBytes(32).toString('hex'),id=randomUUID();
    (this.state.mobileDevices??=[]).push({id,name:name.slice(0,80)||'Android',tokenHash:hash(token),accounts:allowed,createdAt:Date.now(),sendAllowed});this.save();
    return{deviceId:id,token,port:this.port,hosts:this.addresses(),sendAllowed,fingerprint:new X509Certificate(this.state.mobileTLS!.cert).fingerprint256.replace(/:/g,'').toLowerCase()};
  }
  async start(){
    if(this.server)return;
    if(!this.state.mobileTLS){const pems=await generate([{name:'commonName',value:'RelayDesk private mobile gateway'}],{keySize:2048,algorithm:'sha256',notAfterDate:new Date(Date.now()+365*86400000),extensions:[{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'},...this.addresses().map(ip=>({type:7 as const,ip}))]}]});this.state.mobileTLS={key:pems.private,cert:pems.cert};this.save();}
    const server=createServer(this.state.mobileTLS,async(req,res)=>{
      const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
      try{
        const token=(req.headers.authorization||'').replace(/^Bearer /,'');const digest=hash(token);
        const device=this.state.mobileDevices?.find(d=>!d.revoked&&d.tokenHash.length===digest.length&&timingSafeEqual(Buffer.from(d.tokenHash),Buffer.from(digest)));
        if(!device)return send(401,{error:'Unauthorized'});
        const allowed=new Set(device.accounts.filter(id=>this.state.accounts.some(a=>a.id===id)));
        if(req.method==='GET'&&req.url==='/mobile/v1/snapshot')return send(200,{generatedAt:Date.now(),sendAllowed:!!device.sendAllowed,accounts:this.state.accounts.filter(a=>allowed.has(a.id)).map(({id,name,service,lastSync,error})=>({id,name,service,lastSync:lastSync||null,error:!!error,canSend:this.outbox?.canSend(id)||false})),threads:this.state.threads.filter(t=>allowed.has(t.accountId)),messages:this.state.messages.filter(m=>allowed.has(m.accountId)),drafts:this.state.drafts.filter(d=>allowed.has(d.accountId))});
        if(req.method==='POST'&&['/mobile/v1/prepare-send','/mobile/v1/approve-send'].includes(req.url||'')){
          if(!device.sendAllowed||!this.outbox)return send(403,{error:'Sending is not granted to this device'});
          let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>20000)return send(413,{error:'Payload too large'});}
          const input=JSON.parse(raw);const draft=this.state.drafts.find(d=>d.id===input.draftId&&allowed.has(d.accountId));if(!draft)return send(403,{error:'Draft is outside shared scope'});
          if(req.url==='/mobile/v1/prepare-send')return send(200,this.outbox.prepare(draft.id));
          return send(200,await this.outbox.approve(draft.id,String(input.challenge||''),input.explicitConfirmation===true));
        }
        if(req.method==='POST'&&req.url==='/mobile/v1/drafts'){
          let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>20000)return send(413,{error:'Payload too large'});}
          const input=JSON.parse(raw);if(!allowed.has(input.accountId)||!this.state.threads.some(t=>t.accountId===input.accountId&&t.id===input.threadId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>10000)return send(403,{error:'Draft is outside shared scope'});
          const draft={id:randomUUID(),accountId:input.accountId,threadId:input.threadId,text:input.text,createdAt:Date.now(),status:'pending' as const};this.state.drafts.push(draft);this.save();return send(201,{id:draft.id,status:'pending',sent:false});
        }
        return send(404,{error:'Not found'});
      }catch{return send(400,{error:'Invalid request'});}
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.state.mobileGateway?.port||0,'0.0.0.0',()=>{this.port=(server.address() as any).port;resolve();});});this.server=server;this.state.mobileGateway={enabled:true,port:this.port};this.error='';this.save();
  }
  async restore(){if(this.state.mobileGateway?.enabled)try{await this.start();}catch{this.error='スマートフォン同期を再開できません。同じ接続番号の使用状況を確認してください。';}}
  async stop(disable=false){const server=this.server;this.server=null;if(disable){this.state.mobileGateway={enabled:false,port:this.port};this.save();}if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));}
  status(){return{enabled:!!this.server,port:this.port,hosts:this.addresses(),devices:this.devices(),error:this.error};}
}
