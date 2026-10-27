import type {Account,Attachment} from './model.js';
import {MAX_ASSET_BYTES} from './assets.js';
export async function downloadPrivateAttachment(account:Account,file:Attachment,domains:string[],authDomains:string[]=[]){
  if(!file.url)throw Error('この添付の取得先はまだ取得されていません');let url=new URL(file.url);
  const allowed=(u:URL,list:string[])=>u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&list.some(d=>u.hostname===d||u.hostname.endsWith('.'+d));
  for(let hop=0;hop<4;hop++){
    if(!allowed(url,domains))throw Error('この添付の取得先には接続できません');
    const auth=allowed(url,authDomains),response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(45000),headers:auth?{Authorization:account.adapter==='discord'?'Bot '+account.config.token:'Bearer '+account.config.token,...(account.config.cookie?{Cookie:account.config.cookie}:{})}:{}});
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');if(!location)throw Error('添付の転送先を確認できません');await response.body?.cancel();url=new URL(location,url);continue;}
    if(!response.ok||!response.body)throw Error('添付を取得できません。認証またはリンクの有効期限を確認してください');
    const length=Number(response.headers.get('content-length')||0);if(length>MAX_ASSET_BYTES){await response.body.cancel();throw Error('添付は25MBまで取得できます');}
    const chunks:Buffer[]=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>MAX_ASSET_BYTES)throw Error('添付は25MBまで取得できます');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);
  }
  throw Error('添付の転送回数が上限に達しました');
}
