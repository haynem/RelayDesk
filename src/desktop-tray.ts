import {Tray,Menu,nativeImage,type BrowserWindow} from 'electron';
export function setupTray(window:BrowserWindow,iconPath:string,actions:{sync:()=>Promise<void>;quit:()=>void;isQuitting:()=>boolean}){
  try{
    const icon=nativeImage.createFromPath(iconPath);if(icon.isEmpty())return;
    const tray=new Tray(icon.resize({width:20,height:20}));tray.setToolTip('RelayDesk · バックグラウンドで同期中');
    const show=()=>{if(!window.isDestroyed()){window.show();window.focus();}};
    tray.setContextMenu(Menu.buildFromTemplate([{label:'連絡一覧を開く',click:show},{label:'今すぐ同期する',click:()=>void actions.sync()},{type:'separator'},{label:'RelayDeskを終了',click:actions.quit}]));
    tray.on('click',show);tray.on('double-click',show);
    const close=(event:Electron.Event)=>{if(!actions.isQuitting()){event.preventDefault();window.hide();}};window.on('close',close);
    return{dispose:()=>{window.removeListener('close',close);tray.destroy();}};
  }catch{return;}
}
