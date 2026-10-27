import {dialog,type BrowserWindow} from 'electron';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {basename,extname} from 'node:path';
import {MAX_ASSET_BYTES} from './assets.js';
import type {FileHooks} from './asset-service.js';
const types:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.zip':'application/zip'};
export function desktopFiles(owner:()=>BrowserWindow|undefined):FileHooks{
  return{
    pickFiles:async()=>{
      const window=owner();if(!window||window.isDestroyed())throw Error('アプリの画面を開いてから操作してください');
      const selected=await dialog.showOpenDialog(window,{title:'送信するファイルを選択',properties:['openFile','multiSelections']});if(selected.canceled)return[];
      if(selected.filePaths.length>10)throw Error('ファイルは10個まで選択できます');
      try{const sizes=selected.filePaths.map(path=>statSync(path));if(sizes.some(s=>!s.isFile()||s.size>MAX_ASSET_BYTES)||sizes.reduce((sum,s)=>sum+s.size,0)>100*1024*1024)throw Error('size_limit');return selected.filePaths.map(path=>({name:basename(path),mime:types[extname(path).toLowerCase()]||'application/octet-stream',data:readFileSync(path)}));}
      catch{throw Error('ファイルを読み込めません。1個25MB・合計100MBまでの通常ファイルを選択してください');}
    },
    exportFile:async(name,data)=>{
      const window=owner();if(!window||window.isDestroyed())throw Error('アプリの画面を開いてから操作してください');
      const filename=basename(name).replace(/[\\/\x00-\x1f]/g,'_').slice(0,200)||'attachment';const target=await dialog.showSaveDialog(window,{title:'添付ファイルを保存',defaultPath:filename});if(target.canceled||!target.filePath)return false;
      try{writeFileSync(target.filePath,data);return true;}catch{throw Error('ファイルを保存できません。保存先と空き容量を確認してください');}
    }
  };
}
