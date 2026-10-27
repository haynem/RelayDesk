import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {nativeTargets,verifiedNativeTargets} from './native-prebuilt.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),mode=process.argv[2];
const targets=nativeTargets(mode),verified=process.env.RELAY_FORCE_NATIVE_BUILD==='1'?[]:verifiedNativeTargets(root,mode);
if(!targets.length)throw Error('Specify win or mac');
mkdirSync(join(root,'native/bin'),{recursive:true});
const cache=join(root,'.build-toolchains');mkdirSync(cache,{recursive:true});
const bundled=join(cache,'go/bin',process.platform==='win32'?'go.exe':'go');
for(const [GOOS,GOARCH,name]of targets){
  if(verified.includes(name)){process.stdout.write('Verified bundled native helper: '+GOOS+'/'+GOARCH+'\n');continue;}
  const result=spawnSync(process.env.RELAY_GO_BIN||(existsSync(bundled)?bundled:'go'),['build','-trimpath','-buildvcs=false','-o',join(root,'native/bin',name),'.'],{cwd:join(root,'native/messenger'),env:{...process.env,GOOS,GOARCH,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOMODCACHE:process.env.GOMODCACHE||join(cache,'go-mod'),GOCACHE:process.env.GOCACHE||join(cache,'go-cache')},stdio:'inherit',windowsHide:true});
  if(result.error){process.stderr.write('Go 1.27以上が必要です。Goをインストールするか、RELAY_GO_BINに実行ファイルを指定してください。\n');process.exit(1);}
  if(result.status!==0)process.exit(result.status||1);
  process.stdout.write('Built native helper: '+GOOS+'/'+GOARCH+'\n');
}
