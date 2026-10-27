const {app,BrowserWindow}=require('electron');
const path=require('node:path');
const fs=require('node:fs'),os=require('node:os');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'relay-tray-fixture-'));app.setPath('userData',profile);
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  let window,tray;
  try{
    const {setupTray}=await import('../dist/desktop-tray.js');
    window=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
    tray=setupTray(window,path.resolve('ui/tray.png'),{sync:async()=>{},quit:()=>{},isQuitting:()=>false});
    if(!tray)throw Error('Tray creation failed');
    window.close();
    if(window.isDestroyed()||window.isVisible())throw Error('Close did not preserve hidden background window');
    tray.dispose();tray=undefined;
    window.close();
    for(let n=0;n<50&&!window.isDestroyed();n++)await new Promise(resolve=>setTimeout(resolve,20));
    if(!window.isDestroyed())throw Error('Disposing tray did not restore normal close');
    console.log('Tray fixture passed: close hides window; background survives; explicit disposal restores exit.');
    app.quit();
  }catch(e){console.error(e.message);tray?.dispose();if(window&&!window.isDestroyed())window.destroy();app.exit(1);}
});
