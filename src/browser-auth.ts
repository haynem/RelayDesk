import {BrowserWindow,session} from 'electron';
import {randomUUID} from 'node:crypto';
import type {Account} from './model.js';
import {allowAuthPopup,slackTokenFromBody,slackBrowserUrl} from './auth-navigation.js';
export class BrowserAuth {
  private windows=new Map<string,BrowserWindow>();
  async login(service:'slack'|'messenger'):Promise<Account>{
    const existing=this.windows.get(service);if(existing&&!existing.isDestroyed()){existing.show();existing.focus();throw Error('Login already open');}
    const id=randomUUID(),store=session.fromPartition('relay-auth-'+id);
    store.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
    const win=new BrowserWindow({width:1100,height:850,title:service==='slack'?'Slack — RelayDesk用ログイン':'Messenger — RelayDesk用ログイン',webPreferences:{session:store,sandbox:true,nodeIntegration:false,contextIsolation:true}});this.windows.set(service,win);
    const children=new Set<BrowserWindow>();
    const configurePopup=(target:BrowserWindow)=>{
      target.setMenuBarVisibility(false);
      target.webContents.setWindowOpenHandler(({url})=>allowAuthPopup(service,url)?{action:'allow',overrideBrowserWindowOptions:{width:1100,height:850,webPreferences:{session:store,sandbox:true,nodeIntegration:false,contextIsolation:true}}}:{action:'deny'});
      target.webContents.on('did-create-window',child=>{children.add(child);configurePopup(child);child.on('closed',()=>children.delete(child));});
      target.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).protocol!=='https:'){event.preventDefault();const browser=service==='slack'?slackBrowserUrl(url):undefined;if(browser)void target.loadURL(browser).catch(()=>{});}}catch{event.preventDefault();}});
    };
    configurePopup(win);
    win.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).protocol!=='https:')event.preventDefault();}catch{event.preventDefault();}});
    let candidate='',checking=false,settled=false;
    const completion=new Promise<Account>((resolve,reject)=>{
      const finish=(account?:Account)=>{if(settled)return;settled=true;clearInterval(timer);clearTimeout(timeout);store.webRequest.onBeforeSendHeaders(null);store.webRequest.onBeforeRequest(null);this.windows.delete(service);for(const child of children)if(!child.isDestroyed())child.destroy();children.clear();if(!win.isDestroyed())win.destroy();if(account)resolve(account);else reject(Error('Login not completed'));};
      if(service==='slack'){
        store.webRequest.onBeforeSendHeaders({urls:['https://*.slack.com/api/*','https://slack.com/api/*']},(details,cb)=>{for(const [name,value] of Object.entries(details.requestHeaders))if(name.toLowerCase()==='authorization'&&/^Bearer xox/.test(String(value)))candidate=String(value).slice(7);cb({requestHeaders:details.requestHeaders});});
        store.webRequest.onBeforeRequest({urls:['https://*.slack.com/api/*','https://slack.com/api/*']},(details,cb)=>{try{const body=(details.uploadData||[]).map(part=>part.bytes?.toString('utf8')||'').join('');const token=slackTokenFromBody(body)||new URL(details.url).searchParams.get('token');if(token&&/^xox[bpc]-/.test(token))candidate=token;}catch{}cb({});});
      }
      const timer=setInterval(async()=>{if(checking||settled)return;checking=true;try{
        if(service==='messenger'){
          const cookies=await store.cookies.get({url:'https://www.facebook.com'});const owner=cookies.find(c=>c.name==='c_user')?.value;
          if(owner&&cookies.some(c=>c.name==='xs'))finish({id,service:'messenger',adapter:'messenger',name:'Messenger',config:{viewerId:owner,cookies:JSON.stringify(cookies),authOnly:'true'},aiAllowed:false});
        }else if(candidate){
          const attemptToken=candidate;
          const cookies=(await store.cookies.get({})).filter(c=>{const domain=(c.domain||'').replace(/^\./,'');return domain==='slack.com'||domain.endsWith('.slack.com');});const cookie=cookies.filter(c=>c.name==='d'||c.name==='d-s').map(c=>c.name+'='+c.value).join('; ');
          const response=await fetch('https://slack.com/api/auth.test',{headers:{Authorization:'Bearer '+attemptToken,...(cookie?{Cookie:cookie}:{})},signal:AbortSignal.timeout(10000),redirect:'error'});const identity=await response.json() as any;
          if(identity.ok&&typeof identity.user_id==='string'&&typeof identity.team_id==='string')finish({id,service:'slack',adapter:'slack',name:String(identity.team||'Slack')+' / '+String(identity.user||'account'),config:{token:attemptToken,cookie,browserCookies:JSON.stringify(cookies),viewerId:identity.user_id,teamId:identity.team_id,webSession:'true'},aiAllowed:false});
        }
      }catch{}finally{checking=false;}},2000);
      const timeout=setTimeout(()=>finish(),15*60000);win.on('closed',()=>finish());
    });
    void win.loadURL(service==='slack'?'https://slack.com/signin':'https://www.facebook.com/login/').catch(()=>{if(!win.isDestroyed())win.destroy();});win.show();win.focus();return completion;
  }
}
