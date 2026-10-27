import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeTargets,nativeSourceDigest,fileDigest} from './native-prebuilt.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),targets=nativeTargets(process.argv[2]);
if(!targets.length)throw Error('Specify win or mac');
const sourceDigest=nativeSourceDigest(root);let previous={};try{const old=JSON.parse(readFileSync(join(root,'native/bin/prebuilt-manifest.json'),'utf8'));if(old.version===1&&old.sourceDigest===sourceDigest)previous=old.files||{};}catch{}
const files={...previous,...Object.fromEntries(targets.map(([_os,_arch,name])=>[name,fileDigest(join(root,'native/bin',name))]))};
writeFileSync(join(root,'native/bin/prebuilt-manifest.json'),JSON.stringify({version:1,sourceDigest,files},null,2)+'\n');
process.stdout.write('Recorded '+targets.length+' native helper hashes and corresponding source digest.\n');
