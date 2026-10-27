import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
export const nativeTargets=mode=>mode==='win'?[['windows','amd64','messenger-helper.exe']]:mode==='mac'?[['darwin','arm64','messenger-helper-arm64'],['darwin','amd64','messenger-helper-x64']]:[];
export const fileDigest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
export function nativeSourceDigest(root){
  const dir=join(root,'native/messenger'),hash=createHash('sha256');
  for(const name of readdirSync(dir).filter(n=>n==='go.mod'||n==='go.sum'||n.endsWith('.go')&&!n.endsWith('_test.go')).sort()){
    const data=readFileSync(join(dir,name));hash.update(JSON.stringify([name,data.length]));hash.update(data);
  }
  return hash.digest('hex');
}
/** Reuse only fixed target names whose bytes and corresponding source match the manifest. */
export function verifiedNativeTargets(root,mode){
  try{
    const manifest=JSON.parse(readFileSync(join(root,'native/bin/prebuilt-manifest.json'),'utf8'));
    if(manifest.version!==1||manifest.sourceDigest!==nativeSourceDigest(root)||!manifest.files||typeof manifest.files!=='object')return[];
    return nativeTargets(mode).filter(([_os,_arch,name])=>/^[a-f0-9]{64}$/.test(manifest.files[name]||'')&&fileDigest(join(root,'native/bin',name))===manifest.files[name]).map(t=>t[2]);
  }catch{return[];}
}
