import {slackBrowserUrl} from './auth-navigation.js';
import {BrowserWindow,WebContentsView,session,shell,dialog,desktopCapturer,type Session,type WebContents,type Rectangle} from 'electron';
import type {Account,Service} from './model.js';
const hosts:Record<Service,string[]>={instagram:['instagram.com'],messenger:['facebook.com','messenger.com'],slack:['slack.com'],discord:['discord.com','discordapp.com'],email:['google.com','live.com','office.com'],line:[]};
export function serviceUrl(service:Service,a?:Account,threadId?:string){
  if(service==='line')return'line://';
  if(service==='email'){
    const address=a?.config.user||'',host=a?.config.host||'';
    if(/office365|outlook\.office/i.test(host))return'https://outlook.office.com/mail/?login_hint='+encodeURIComponent(address);
    if(/outlook|hotmail/i.test(host))return'https://outlook.live.com/mail/?login_hint='+encodeURIComponent(address);
    if(!a||/gmail\.com$/i.test(host))return'https://mail.google.com/mail/?authuser='+encodeURIComponent(address);
    throw Error('このメールサービスのWeb画面は未設定です。メールの閲覧・新規作成は統合画面で利用してください。');
  }
  if(service==='slack'&&a?.config.teamId&&threadId&&/^[CDG][A-Z0-9]+$/.test(threadId))return'https://app.slack.com/client/'+encodeURIComponent(a.config.teamId)+'/'+threadId;
  return{instagram:'https://www.instagram.com/direct/inbox/',messenger:'https://www.facebook.com/messages/',slack:a?.config.teamId?'https://app.slack.com/client/'+encodeURIComponent(a.config.teamId):'https://slack.com/signin',discord:'https://discord.com/app'}[service];
}
export function ownServiceHost(service:Service,url:string){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&hosts[service].some(host=>u.hostname===host||u.hostname.endsWith('.'+host));}catch{return false;}}
function sso(url:string){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&['accounts.google.com','login.microsoftonline.com','appleid.apple.com'].includes(u.hostname);}catch{return false;}}
type Surface={contents:WebContents;window?:BrowserWindow;view?:WebContentsView;accountId?:string;dispose:()=>Promise<void>;children:Set<BrowserWindow>};
/** Official screens never receive the main renderer's local API key or Node access. */
export class ServiceWindows {
  private surfaces=new Map<string,Surface>();private active?:string;private generation=0;private margins?:{left:number;top:number;right:number;bottom:number};private boundOwner?:BrowserWindow;
  constructor(private account:(id:string)=>Account|undefined,private save:()=>void,private owner:()=>BrowserWindow|undefined=()=>undefined){}
  hide(){this.generation++;for(const s of this.surfaces.values())s.view?.setVisible(false);this.active=undefined;}
  reload(){const s=this.active?this.surfaces.get(this.active):undefined;if(s&&!s.contents.isDestroyed())s.contents.reload();}
  setBounds(bounds:Rectangle){
    const owner=this.owner(),surface=this.active?this.surfaces.get(this.active):undefined;if(!owner||!surface?.view)return;
    const content=owner.getContentBounds(),zoom=owner.webContents.getZoomFactor();
    const left=Math.min(content.width-120,Math.max(180,Math.round(bounds.x*zoom))),top=Math.min(content.height-100,Math.max(70,Math.round(bounds.y*zoom)));
    const width=Math.min(content.width-left,Math.max(100,Math.round(bounds.width*zoom))),height=Math.min(content.height-top,Math.max(100,Math.round(bounds.height*zoom)));
    surface.view.setBounds({x:left,y:top,width,height});
    this.margins={left,top,right:Math.max(0,content.width-left-width),bottom:Math.max(0,content.height-top-height)};
    if(this.boundOwner!==owner){this.boundOwner=owner;owner.on('resize',()=>this.resize());}
  }
  private resize(){const surface=this.active?this.surfaces.get(this.active):undefined,owner=this.owner(),m=this.margins;if(!surface?.view||!owner||!m)return;const b=owner.getContentBounds();surface.view.setBounds({x:m.left,y:m.top,width:Math.max(100,b.width-m.left-m.right),height:Math.max(100,b.height-m.top-m.bottom)});}
  async open(service:Service,accountId?:string,bounds?:Rectangle,threadId?:string){
    const account=accountId?this.account(accountId):undefined;
    if(accountId&&(!account||account.service!==service))throw Error('アカウントが一致しません');
    const url=serviceUrl(service,account,threadId);if(service==='line'||service==='email'){await shell.openExternal(url);return;}
    const owner=this.owner(),embedded=!!bounds&&!!owner,key=service+':'+(accountId||'unconnected')+':'+(embedded?'embedded':'window');
    const previous=this.surfaces.get(key);
    if(previous&&!previous.contents.isDestroyed()){
      if(previous.view){this.hide();this.active=key;previous.view.setVisible(true);this.setBounds(bounds!);}else{previous.window?.show();previous.window?.focus();}
      if(threadId)await previous.contents.loadURL(url);previous.contents.focus();return;
    }
    const partition=account?service==='instagram'?'relay-instagram-'+account.id:service==='slack'||service==='messenger'?'relay-auth-'+account.id:'relay-workspace-'+account.id:'relay-workspace-'+service;
    const store=session.fromPartition(partition);store.setUserAgent(store.getUserAgent().replace(/\sElectron\/\S+/g,'').replace(/\srelaydesk-private\/\S+/gi,''));
    const generation=this.generation;await this.restoreCookies(store,service,account);if(embedded&&generation!==this.generation)return;
    const preferences={session:store,sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:true};
    const view=embedded?new WebContentsView({webPreferences:preferences}):undefined;
    const win=view?undefined:new BrowserWindow({width:1250,height:900,title:service+' — '+(account?.name||'元のサービス画面'),webPreferences:preferences});
    win?.setMenuBarVisibility(false);
    const contents=view?view.webContents:win!.webContents,dialogOwner=win||owner!;
    const children=new Set<BrowserWindow>(),dispose=this.trackCookies(store,service,accountId);
    const surface:Surface={contents,window:win,view,accountId,dispose,children};this.surfaces.set(key,surface);
    this.permissions(store,service,dialogOwner);
    const configure=(wc:WebContents)=>{
      let externalPending=false;
      const external=async(url:string)=>{
        let parsed:URL;try{parsed=new URL(url);}catch{return;}
        if(externalPending||parsed.protocol!=='https:'||parsed.username||parsed.password)return;
        externalPending=true;
        try{const answer=await dialog.showMessageBox(dialogOwner,{type:'question',buttons:['戻る','ブラウザーで開く'],defaultId:0,cancelId:0,message:'メッセージの外部リンクを開きますか？',detail:parsed.hostname+'\n\n'+parsed.href});if(answer.response===1)await shell.openExternal(parsed.href);}catch{}finally{externalPending=false;}
      };
      wc.setWindowOpenHandler(({url})=>{if(ownServiceHost(service,url)||sso(url))return{action:'allow',overrideBrowserWindowOptions:{webPreferences:preferences}};void external(url);return{action:'deny'};});
      wc.on('did-create-window',child=>{children.add(child);configure(child.webContents);child.on('closed',()=>children.delete(child));});
      wc.on('will-navigate',(event,url)=>{if(!ownServiceHost(service,url)&&!sso(url)){event.preventDefault();const browser=service==='slack'?slackBrowserUrl(url):undefined;if(browser)void wc.loadURL(browser).catch(()=>{});else void external(url);}});
    };configure(contents);
    if(view){this.hide();this.active=key;view.setBackgroundColor('#ffffff');owner!.contentView.addChildView(view);view.setVisible(true);this.setBounds(bounds!);}
    win?.on('closed',()=>{void dispose().catch(()=>{});for(const child of children)if(!child.isDestroyed())child.destroy();this.surfaces.delete(key);});
    try{await contents.loadURL(url);if(!view||this.active===key)contents.focus();}catch{await this.closeSurface(key,surface);throw Error('元サービスの画面を開けませんでした。ネットワークと公式サービスの状態を確認してください。');}
  }
  private permissions(store:Session,service:Service,owner:BrowserWindow){
    const grants=new Set<string>();let capturePending=false;
    store.setDisplayMediaRequestHandler(async(request,callback)=>{
      if(capturePending||!request.userGesture||!ownServiceHost(service,request.securityOrigin)){callback({});return;}capturePending=true;
      try{
        const sources=await desktopCapturer.getSources({types:['window','screen'],thumbnailSize:{width:0,height:0},fetchWindowIcons:false});const choices=sources.slice(0,30);if(!choices.length){callback({});return;}
        const selected=await dialog.showMessageBox(owner,{type:'question',message:'共有する画面・ウィンドウを選んでください',detail:'この選択は元サービスの通話・画面共有へ映像を渡します。',buttons:['キャンセル',...choices.map((s,i)=>(i+1)+'. '+s.name.slice(0,70))],defaultId:0,cancelId:0,...(request.audioRequested&&process.platform==='win32'?{checkboxLabel:'PCの音声も共有する',checkboxChecked:false}:{})});
        const source=choices[selected.response-1];if(!source){callback({});return;}callback({video:source,...(selected.checkboxChecked&&request.audioRequested&&process.platform==='win32'?{audio:'loopback' as const}:{})});
      }catch{callback({});}finally{capturePending=false;}
    });
    store.setPermissionCheckHandler((_wc,permission,origin)=>ownServiceHost(service,origin)&&grants.has(new URL(origin).origin+':'+permission));
    store.setPermissionRequestHandler(async(wc,permission,cb,details)=>{
      const origin=details.requestingUrl||wc.getURL();
      if(!ownServiceHost(service,origin)||!['media','display-capture','fullscreen','notifications','clipboard-read','clipboard-sanitized-write'].includes(permission)){cb(false);return;}
      try{const answer=await dialog.showMessageBox(owner,{type:'question',buttons:['許可しない','今回だけ許可'],defaultId:0,cancelId:0,message:'元サービスが機能の利用許可を求めています',detail:new URL(origin).hostname+' / '+({media:'マイク・カメラ', 'display-capture':'画面共有',fullscreen:'全画面表示',notifications:'このサービスの通知','clipboard-read':'クリップボードの読み取り','clipboard-sanitized-write':'クリップボードへのコピー'} as Record<string,string>)[permission]});if(answer.response===1)grants.add(new URL(origin).origin+':'+permission);cb(answer.response===1);}catch{cb(false);}
    });
  }
  private trackCookies(store:Session,service:Service,accountId?:string){
    let timer:ReturnType<typeof setTimeout>|undefined;
    const saveCookies=async()=>{
      if(!accountId||!['instagram','messenger','slack'].includes(service))return;
      const current=this.account(accountId);if(!current)return;
      const cookies=(await store.cookies.get({})).filter(c=>hosts[service].some(h=>c.domain===h||(c.domain||'').endsWith('.'+h)));
      const owner=service==='instagram'?cookies.find(c=>c.name==='ds_user_id')?.value:service==='messenger'?cookies.find(c=>c.name==='c_user')?.value:current.config.viewerId;
      if(!owner||owner!==current.config.viewerId)return;
      if(service==='slack'){
        const cookie=cookies.filter(c=>c.name==='d'||c.name==='d-s').map(c=>c.name+'='+c.value).join('; ');
        const response=await fetch('https://slack.com/api/auth.test',{headers:{Authorization:'Bearer '+current.config.token,Cookie:cookie},signal:AbortSignal.timeout(10000),redirect:'error'});
        const identity=await response.json() as any;if(!identity.ok||identity.user_id!==current.config.viewerId||(current.config.teamId&&identity.team_id!==current.config.teamId))return;
        current.config.browserCookies=JSON.stringify(cookies);current.config.cookie=cookie;
      }else current.config.cookies=JSON.stringify(cookies);
      this.save();
    };
    const changed=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>void saveCookies().catch(()=>{}),2000);};store.cookies.on('changed',changed);
    return async()=>{if(timer)clearTimeout(timer);store.cookies.removeListener('changed',changed);await saveCookies();};
  }
  async forget(accountId:string){const stores=new Set<Session>();for(const [key,s] of this.surfaces)if(s.accountId===accountId){stores.add(s.contents.session);await this.closeSurface(key,s);}for(const store of stores)await store.clearStorageData();}
  async closeAll(){for(const [key,s] of this.surfaces)await this.closeSurface(key,s);}
  private async closeSurface(key:string,s:Surface){
    await s.dispose().catch(()=>{});for(const child of s.children)if(!child.isDestroyed())child.destroy();
    if(s.view){const owner=this.owner();if(owner&&!owner.isDestroyed())owner.contentView.removeChildView(s.view);if(!s.contents.isDestroyed())s.contents.close();}else if(s.window&&!s.window.isDestroyed())s.window.destroy();
    this.surfaces.delete(key);if(this.active===key)this.active=undefined;
  }
  private async restoreCookies(store:Session,service:Service,a?:Account){
    if(!a)return;const raw=service==='slack'?a.config.browserCookies:a.config.cookies;let cookies:any[]=[];try{cookies=JSON.parse(raw||'[]');}catch{}
    if(service==='slack'&&!cookies.length&&a.config.cookie)cookies=a.config.cookie.split('; ').map(pair=>{const at=pair.indexOf('=');return{name:pair.slice(0,at),value:pair.slice(at+1),domain:'.slack.com',path:'/',secure:true,httpOnly:true};});
    for(const c of cookies){if(typeof c.expirationDate==='number'&&c.expirationDate<=Date.now()/1000)continue;if(!hosts[service].some(h=>c.domain===h||c.domain?.endsWith('.'+h)))continue;const host=String(c.domain).replace(/^\./,'');await store.cookies.set({url:'https://'+host+(c.path||'/'),name:String(c.name),value:String(c.value),domain:c.domain,path:c.path||'/',secure:true,httpOnly:!!c.httpOnly,...(typeof c.expirationDate==='number'?{expirationDate:c.expirationDate}:{}),...(c.sameSite?{sameSite:c.sameSite}:{})});}
  }
}
