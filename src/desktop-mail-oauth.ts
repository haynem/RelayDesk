import {dialog,shell,type BrowserWindow} from 'electron';
import {readFileSync,statSync} from 'node:fs';
import {loginMailOAuth} from './mail-oauth.js';
export function desktopMailOAuth(owner:()=>BrowserWindow|undefined){return async(input:{provider:'google'|'microsoft';clientId?:string;gmailFilters?:boolean})=>{
  if(!['google','microsoft'].includes(input.provider))throw Error('メールサービスを選んでください');let clientId=input.clientId||'',clientSecret='';
  if(input.provider==='google'){
    const window=owner();if(!window)throw Error('RelayDeskの画面を開いてください');const picked=await dialog.showOpenDialog(window,{title:'自分のGoogle OAuthデスクトップアプリの認証JSONを選択',properties:['openFile'],filters:[{name:'Google OAuth client',extensions:['json']}]});if(picked.canceled||!picked.filePaths[0])throw Error('認証設定ファイルの選択を取り消しました');
    try{if(statSync(picked.filePaths[0]).size>1024*1024)throw Error();const raw=JSON.parse(readFileSync(picked.filePaths[0],'utf8')).installed;if(!raw||typeof raw.client_id!=='string'||!raw.client_id.endsWith('.apps.googleusercontent.com')||typeof raw.client_secret!=='string')throw Error();clientId=raw.client_id;clientSecret=raw.client_secret;}catch{throw Error('Googleの「デスクトップアプリ」用OAuth JSONを選択してください');}
  }else if(!/^[0-9a-f-]{36}$/i.test(clientId))throw Error('Microsoftアプリ登録のクライアントIDを入力してください');
  return loginMailOAuth({provider:input.provider,clientId,clientSecret,gmailFilters:input.gmailFilters},url=>shell.openExternal(url));
};}
