import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifiedNativeTargets,nativeSourceDigest,fileDigest} from '../scripts/native-prebuilt.mjs';
test('bundled helper reuse requires matching source and both target file hashes; changed files are rejected',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-native-fixture-'));
  try{
    mkdirSync(join(root,'native/messenger'),{recursive:true});mkdirSync(join(root,'native/bin'),{recursive:true});
    writeFileSync(join(root,'native/messenger/main.go'),'package main');writeFileSync(join(root,'native/messenger/go.mod'),'module fixture');
    const names=['messenger-helper-arm64','messenger-helper-x64'];for(const name of names)writeFileSync(join(root,'native/bin',name),'fixture-'+name);
    const manifest={version:1,sourceDigest:nativeSourceDigest(root),files:Object.fromEntries(names.map(n=>[n,fileDigest(join(root,'native/bin',n))]))};
    writeFileSync(join(root,'native/bin/prebuilt-manifest.json'),JSON.stringify(manifest));assert.deepEqual(verifiedNativeTargets(root,'mac'),names);
    writeFileSync(join(root,'native/bin/messenger-helper-x64'),'changed');assert.deepEqual(verifiedNativeTargets(root,'mac'),['messenger-helper-arm64']);
    writeFileSync(join(root,'native/messenger/main.go'),'package changed');assert.deepEqual(verifiedNativeTargets(root,'mac'),[]);
  }finally{rmSync(root,{recursive:true});}
});
