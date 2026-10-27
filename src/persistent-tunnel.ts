import type {State} from './model.js';
import type {PrivateTunnel,TunnelOptions} from './desktop-tunnel.js';
import type {RemoteMcp} from './remote-mcp.js';
export type PersistentTunnelState={enabled:boolean;origin:string;port:number;token:string};
export class PersistentTunnel {
  private tunnel?:PrivateTunnel;private timer?:ReturnType<typeof setTimeout>;private pending=false;private stopped=false;private generation=0;private failures=0;private error='';private verified=false;private nextRetryAt?:number;private abort?:AbortController;
  constructor(private state:State,private save:()=>void,private mcp:RemoteMcp,private launch?:(port:number,onExit:()=>void,options?:TunnelOptions)=>Promise<PrivateTunnel>){}
  status(){const config=this.state.persistentTunnel;return{supported:!!this.launch,enabled:config?.enabled===true,origin:config?.origin||'',port:config?.port||18765,hasToken:!!config?.token,pending:this.pending,running:!!this.tunnel,verified:this.verified,error:this.error,nextRetryAt:this.nextRetryAt};}
  async configure(input:{enabled:boolean;origin:string;port:number;token?:string;explicitConfirmation?:boolean}){
    if(input.explicitConfirmation!==true||typeof input.enabled!=='boolean')throw Error('固定接続の公開・再起動時の自動再開を画面で確認してください');
    if(!this.launch)throw Error('このPCでは固定トンネルを利用できません');
    const url=new URL(input.origin);if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname)||url.hostname.endsWith('.trycloudflare.com'))throw Error('自分が管理する固定HTTPSホスト名を入力してください');
    if(!Number.isInteger(input.port)||input.port<1024||input.port>65535)throw Error('受付ポートが無効です');
    const token=input.token||this.state.persistentTunnel?.token||'';if(input.enabled&&(!/^[a-zA-Z0-9_+/=-]+$/.test(token)||token.length<40||token.length>10000))throw Error('Cloudflareの固定トンネル用トークンをこの設定画面で入力してください');
    await this.stopWorker();this.state.persistentTunnel={enabled:input.enabled,origin:url.origin,port:input.port,token};this.stopped=false;this.failures=0;this.error='';this.save();
    await this.mcp.configure({enabled:input.enabled,origin:url.origin,port:input.port});if(input.enabled)void this.restore();return this.status();
  }
  async disable(){await this.stopWorker();if(this.state.persistentTunnel)this.state.persistentTunnel.enabled=false;this.save();const status=this.mcp.status();await this.mcp.configure({enabled:false,origin:status.origin,port:status.port});return this.status();}
  async restore(){
    const config=this.state.persistentTunnel;if(this.stopped||!config?.enabled||!this.launch||this.pending||this.tunnel)return;
    const epoch=++this.generation;this.pending=true;this.nextRetryAt=undefined;const abort=new AbortController();this.abort=abort;
    try{
      const status=this.mcp.status();if(!status.enabled||status.origin!==config.origin||status.port!==config.port)await this.mcp.configure({enabled:true,origin:config.origin,port:config.port});else if(!status.listening)await this.mcp.restore();
      if(!this.mcp.status().listening)throw Error('listener_stopped');
      const tunnel=await this.launch(config.port,()=>{if(epoch!==this.generation)return;this.tunnel=undefined;this.verified=false;this.error='固定接続が中断したため自動再接続を待っています';this.retry();},{origin:config.origin,token:config.token,signal:abort.signal});
      if(this.stopped||epoch!==this.generation){await tunnel.close();return;}this.tunnel=tunnel;
      // Confirm the fixed host reaches this exact listener, without fetching private chat data.
      const response=await fetch(config.origin+'/.well-known/relaydesk-instance',{redirect:'error',signal:AbortSignal.timeout(15000)}),value:any=await response.json();
      if(!response.ok||value.instance!==this.mcp.instanceId||value.resource!==config.origin+'/mcp')throw Error('routing_mismatch');
      if(this.stopped||epoch!==this.generation)return;this.verified=true;this.failures=0;this.error='';
    }catch{if(epoch===this.generation&&!this.stopped){const opened=this.tunnel;this.tunnel=undefined;await opened?.close();this.verified=false;this.error='固定接続を確認できません。Cloudflareでこのホストの転送先を http://127.0.0.1:'+config.port+' に設定し、DNS・トンネルトークンを確認してください';this.retry();}}
    finally{if(epoch===this.generation)this.pending=false;}
  }
  private retry(){if(this.stopped||!this.state.persistentTunnel?.enabled||this.timer)return;const delay=Math.min(300000,15000*2**Math.min(this.failures++,5))+Math.floor(Math.random()*3000);this.nextRetryAt=Date.now()+delay;this.timer=setTimeout(()=>{this.timer=undefined;void this.restore();},delay);this.timer.unref();}
  private async stopWorker(){this.generation++;this.abort?.abort();this.abort=undefined;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.nextRetryAt=undefined;this.pending=false;this.verified=false;const current=this.tunnel;this.tunnel=undefined;await current?.close();}
  async close(){this.stopped=true;await this.stopWorker();}
}
