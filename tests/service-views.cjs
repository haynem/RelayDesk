// Native service-pane test. All HTTPS requests are intercepted with synthetic HTML.
const {app,BrowserWindow,WebContentsView,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'relay-service-ui-'));app.setPath('userData',profile);
let manager,owner;
app.whenReady().then(async()=>{
 try{
  const {ServiceWindows,ownServiceHost}=await import('../dist/service-windows.js');
  const mainSession=session.fromPartition('relay-main-fixture'),remoteSession=session.fromPartition('relay-instagram-embed-fixture');
  await mainSession.protocol.handle('https',()=>new Response('<html><body>架空の親画面</body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}}));
  await remoteSession.protocol.handle('https',()=>new Response('<html><body><h1>架空のサービス画面</h1><button id="compose">新規メッセージ</button></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}}));
  owner=new BrowserWindow({width:1300,height:850,show:false,webPreferences:{session:mainSession,sandbox:true,nodeIntegration:false,contextIsolation:true}});
  await owner.loadURL('https://relaydesk.example.test/');await owner.webContents.executeJavaScript("sessionStorage.setItem('relaySession','SYNTHETIC-MAIN-KEY')");
  const account={id:'embed-fixture',service:'instagram',adapter:'instagram',name:'Fixture',config:{},aiAllowed:false};
  manager=new ServiceWindows(id=>id===account.id?account:undefined,()=>{},()=>owner);
  await manager.open('instagram',account.id,{x:260,y:170,width:950,height:600});
  const view=owner.contentView.children.find(v=>v instanceof WebContentsView&&v.webContents!==owner.webContents);if(!view)throw Error('Service view was not embedded');
  if(!view.getVisible())throw Error('Embedded service was hidden');
  if(!await view.webContents.executeJavaScript("typeof require==='undefined' && sessionStorage.getItem('relaySession')===null && !!document.querySelector('#compose')"))throw Error('Service sandbox or storage boundary failed');
  if(view.getBounds().x!==260)throw Error('Service bounds did not preserve sidebar');
  manager.hide();if(view.getVisible())throw Error('Service remained over normalized inbox');
  await manager.open('instagram',account.id,{x:260,y:170,width:900,height:550});
  if(owner.contentView.children.filter(v=>v instanceof WebContentsView&&v.webContents!==owner.webContents).length!==1)throw Error('Service recreation duplicated views');
  if(!view.getVisible())throw Error('Service did not resume');
  if(ownServiceHost('instagram','https://instagram.com.evil.test/')||ownServiceHost('instagram','file:///C:/fixture'))throw Error('Service host policy too broad');
  const remoteContents=view.webContents;
  await manager.forget(account.id);if(!remoteContents.isDestroyed())await new Promise(r=>setTimeout(r,100));
  if(!remoteContents.isDestroyed())throw Error('Removed account left a service view');
  fs.writeFileSync(path.resolve('docs/verification/service-views-result.json'),JSON.stringify({ok:true,syntheticOnly:true,realServiceRequests:0,checks:['embedded native view','main key isolated','Node disabled','sidebar preserved','hide and resume','no duplicate view','account removal closes surface','host spoof rejected']},null,2));
  console.log('Native service panes passed: 8 checks; synthetic only; zero real service requests.');
  await manager.closeAll();owner.destroy();app.quit();
 }catch(e){console.error(e.message);if(manager)await manager.closeAll().catch(()=>{});if(owner&&!owner.isDestroyed())owner.destroy();app.exit(1);}
}).finally(()=>{try{fs.rmSync(profile,{recursive:true});}catch{}});
