// Workspace-local, checksum-verified Go toolchain for the one-click macOS build.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifiedNativeTargets} from './native-prebuilt.mjs';
const version='1.27.3',root=fileURLToPath(new URL('../',import.meta.url)),tools=join(root,'.build-toolchains');
if(process.env.RELAY_FORCE_NATIVE_BUILD!=='1'&&verifiedNativeTargets(root,'mac').length===2){process.stdout.write('Mac用の補助プログラムを検証済みです。Goのダウンロードは不要です。\n');process.exit(0);}
if(process.env.RELAY_GO_BIN)process.exit(0);
const installed=spawnSync('go',['version'],{encoding:'utf8',windowsHide:true}),match=installed.stdout?.match(/go1\.(\d+)\./);
if(installed.status===0&&match&&Number(match[1])>=27)process.exit(0);
if(process.platform!=='darwin'||!['arm64','x64'].includes(process.arch))throw Error('Install Go 1.27 or newer for this platform');
const bundled=join(tools,'go/bin/go');
if(existsSync(bundled)&&spawnSync(bundled,['version'],{encoding:'utf8'}).stdout?.includes('go'+version))process.exit(0);
mkdirSync(tools,{recursive:true});
const filename=`go${version}.darwin-${process.arch==='x64'?'amd64':'arm64'}.tar.gz`,archive=join(tools,filename);
const metadata=await fetch('https://go.dev/dl/?mode=json&include=all',{signal:AbortSignal.timeout(30000)});if(!metadata.ok)throw Error('Cannot verify official Go release metadata');
const releases=await metadata.json(),file=releases.find(r=>r.version==='go'+version)?.files.find(f=>f.filename===filename);
if(!file||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Pinned Go release was not found in official metadata');
let bytes=existsSync(archive)?readFileSync(archive):undefined;
if(!bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256){const response=await fetch('https://go.dev/dl/'+filename,{signal:AbortSignal.timeout(300000)});if(!response.ok)throw Error('Cannot download Go');bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Go checksum mismatch');writeFileSync(archive,bytes);}
const extracted=spawnSync('tar',['-xzf',archive,'-C',tools],{stdio:'inherit'});if(extracted.status!==0)throw Error('Cannot extract Go toolchain');
process.stdout.write('Prepared verified Go '+version+' in the project build directory.\n');
