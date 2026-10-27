import {BrowserWindow,session,type Session} from 'electron';
import {randomUUID} from 'node:crypto';
import type {Account} from './model.js';
import {InstagramGraphqlAdapter,InstagramGraphqlClient} from './adapters/instagram-graphql.js';
export class InstagramRuntime {
  private sessions=new Map<string,Session>();
  private loginWindow:BrowserWindow|null=null;
  private ua=session.defaultSession.getUserAgent().replace(/\sElectron\/\S+/g,'').replace(/\srelaydesk-private\/\S+/gi,'');
  adapter=new InstagramGraphqlAdapter(new InstagramGraphqlClient(this.ua));
  async login():Promise<Account>{
    if(this.loginWindow&&!this.loginWindow.isDestroyed()){this.loginWindow.show();this.loginWindow.focus();throw Error('Instagramのログイン画面がすでに開いています。');}
    const id=randomUUID(),s=session.fromPartition(`relay-instagram-${id}`);s.setUserAgent(this.ua);s.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
    const win=new BrowserWindow({width:1000,height:800,title:'Instagram — RelayDesk用ログイン',webPreferences:{session:s,sandbox:true,nodeIntegration:false,contextIsolation:true}});this.loginWindow=win;
    win.setMenuBarVisibility(false);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{try{const u=new URL(url);if(u.protocol!=='https:'||!/(^|\.)instagram\.com$/.test(u.hostname)||u.pathname.startsWith('/direct/'))event.preventDefault();}catch{event.preventDefault();}});
    const promise=new Promise<Account>((resolve,reject)=>{
      let done=false,checking=false;
      const finish=(a?:Account)=>{if(done)return;done=true;clearInterval(timer);clearTimeout(timeout);if(!win.isDestroyed())win.destroy();this.loginWindow=null;if(a){this.sessions.set(id,s);resolve(a);}else{void s.clearStorageData();reject(Error('Instagramのログインは完了していません。'));}};
      const timer=setInterval(async()=>{if(checking||done)return;checking=true;try{const cookies=await s.cookies.get({url:'https://www.instagram.com'});const owner=cookies.find(c=>c.name==='ds_user_id')?.value;if(owner&&cookies.some(c=>c.name==='sessionid')&&cookies.some(c=>c.name==='csrftoken'))finish({id,service:'instagram',adapter:'instagram',name:'Instagram',config:{viewerId:owner,cookies:JSON.stringify(cookies)},aiAllowed:false});}catch{}finally{checking=false;}},1000);
      const timeout=setTimeout(()=>finish(),10*60000);win.on('closed',()=>finish());
    });
    void win.loadURL('https://www.instagram.com/accounts/login/').catch(()=>{if(!win.isDestroyed())win.destroy();});win.show();win.focus();
    return promise;
  }
  async forget(id:string){this.adapter.forget(id);const s=this.sessions.get(id);this.sessions.delete(id);if(s)await s.clearStorageData();}
}
