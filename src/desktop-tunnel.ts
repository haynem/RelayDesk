import {spawn,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
export type TunnelOptions={origin:string;token:string;signal?:AbortSignal};
export type PrivateTunnel={origin:string;close:()=>Promise<void>};
const MAX_BYTES=100*1024*1024;
/** Optional public networking occurs only after explicit consent in the local UI. Never called on startup. */
export function desktopTunnel(directory:string){return async(port:number,onExit:()=>void,options?:TunnelOptions):Promise<PrivateTunnel>=>{
  if(process.platform!=='win32'||process.arch!=='x64'||!Number.isInteger(port)||port<1024||port>65535)throw Error('簡易トンネルはWindows x64で利用できます');
  const signal=(ms:number)=>options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);
  if(options){const origin=new URL(options.origin);if(origin.protocol!=='https:'||origin.username||origin.password||!options.token)throw Error('固定トンネル設定が無効です');}
  const dir=join(directory,'tools','cloudflared');mkdirSync(dir,{recursive:true});const executable=join(dir,'cloudflared.exe'),manifest=join(dir,'release.json');let reusable=false;
  if(existsSync(executable)&&existsSync(manifest))try{const info=JSON.parse(readFileSync(manifest,'utf8'));reusable=typeof info.sha256==='string'&&/^[a-f0-9]{64}$/.test(info.sha256)&&createHash('sha256').update(readFileSync(executable)).digest('hex')===info.sha256;}catch{}
  if(!reusable){
    const response=await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'RelayDesk-private'},redirect:'error',signal:signal(30000)});if(!response.ok)throw Error('Cloudflare公式ツールのリリース情報を取得できません');
    const release=await response.json() as any,asset=release.assets?.find((a:any)=>a.name==='cloudflared-windows-amd64.exe'),digest=typeof asset?.digest==='string'?asset.digest.replace(/^sha256:/,''):'';
    if(!/^[a-f0-9]{64}$/.test(digest)||typeof asset.browser_download_url!=='string'||!/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/[^/]+\/cloudflared-windows-amd64\.exe$/.test(asset.browser_download_url)||asset.size>MAX_BYTES)throw Error('公式ツールのSHA-256を確認できないためダウンロードを中止しました');
    let url=asset.browser_download_url,bytes:Buffer|undefined;
    for(let hops=0;hops<5;hops++){
      const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(target.hostname))throw Error('ツールの配布先が公式ダウンロード先と一致しません');
      const download=await fetch(url,{redirect:'manual',signal:signal(180000)});if([301,302,303,307,308].includes(download.status)){const location=download.headers.get('location');if(!location)throw Error('ダウンロード先が無効です');url=new URL(location,url).href;continue;}
      if(!download.ok||!download.body||Number(download.headers.get('content-length')||0)>MAX_BYTES)throw Error('公式ツールをダウンロードできません');const chunks:Buffer[]=[];let size=0;for await(const chunk of download.body as any){size+=chunk.length;if(size>MAX_BYTES)throw Error('ツールのサイズ上限を超えました');chunks.push(Buffer.from(chunk));}bytes=Buffer.concat(chunks);break;
    }
    if(!bytes||createHash('sha256').update(bytes).digest('hex')!==digest||bytes.subarray(0,2).toString()!=='MZ')throw Error('ツールの整合性を確認できません');
    writeFileSync(executable+'.tmp',bytes,{mode:0o700});if(existsSync(executable))unlinkSync(executable);renameSync(executable+'.tmp',executable);writeFileSync(manifest,JSON.stringify({version:String(release.tag_name),sha256:digest}),{mode:0o600});
  }
  if(options?.signal?.aborted)throw Error('接続を取り消しました');
  const config=join(dir,'empty-config.json');writeFileSync(config,'{}',{mode:0o600});
  return new Promise<PrivateTunnel>((resolve,reject)=>{
    let child:ChildProcess,settled=false,closing=false,buffer='';
    const fail=()=>{if(!settled){settled=true;clearTimeout(timeout);child?.kill();reject(Error('簡易トンネルを起動できません。ネットワーク・公式配布ツール・Cloudflareの状態を確認してください'));}else if(!closing)onExit();};
    const timeout=setTimeout(fail,90000);
    const args=options?['tunnel','--config',config,'--no-autoupdate','--protocol','http2','run']:['tunnel','--config',config,'--no-autoupdate','--url',`http://127.0.0.1:${port}`,'--protocol','http2'];
    child=spawn(executable,args,{cwd:dir,windowsHide:true,stdio:['ignore','ignore','pipe'],env:options?{...process.env,TUNNEL_TOKEN:options.token}:process.env});
    const abort=()=>{closing=true;child.kill();if(!settled){settled=true;clearTimeout(timeout);reject(Error('接続を取り消しました'));}};options?.signal?.addEventListener('abort',abort,{once:true});child.once('close',()=>options?.signal?.removeEventListener('abort',abort));child.once('error',fail);child.once('close',fail);
    child.stderr?.setEncoding('utf8');child.stderr?.on('data',chunk=>{
      if(settled)return;buffer=(buffer+String(chunk)).slice(-16000);const found=options&&/Registered tunnel connection/.test(buffer)?[options.origin]:buffer.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/);if(!found||settled)return;settled=true;clearTimeout(timeout);buffer='';
      resolve({origin:found[0],close:async()=>{if(closing)return;closing=true;if(child.exitCode!==null||child.signalCode)return;await new Promise<void>(done=>{const timer=setTimeout(()=>{child.kill();done();},5000);child.once('close',()=>{clearTimeout(timer);done();});child.kill();});}});
    });
  });
};}
