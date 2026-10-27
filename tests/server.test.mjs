import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {randomBytes} from 'node:crypto';
import {Vault} from '../dist/vault.js';import {startServer} from '../dist/server.js';
test('HTTP integration: authentication, grants, sync, search data, drafts, no writes, revocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-http-'));const vault=new Vault(dir,randomBytes(32));let calls=0;
 const adapter={sync:async a=>{calls++;return{threads:[{id:'t',accountId:a.id,title:'Sample',members:['Sender'],membersComplete:false,updatedAt:123}],messages:[{id:'m',threadId:'t',accountId:a.id,text:'Sample message',ts:123,isMe:false,attachments:[]}]};}};
 const b=await startServer(vault,resolve('ui'),{slack:adapter});const base=`http://127.0.0.1:${b.port}`;
 const api=async(path,data)=>{const r=await fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{'X-Relay-Session':b.session,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:r.status,data:await r.json()};};
 try{
 assert.equal((await fetch(base+'/api/state')).status,401);
 assert.equal((await fetch(base+'/api/state',{headers:{'X-Relay-Session':b.session,Origin:'https://evil.example'}})).status,403);
 assert.equal((await api('connect',{adapter:'slack',name:'Test',config:{token:'sample-secret'}})).status,200);await b.sync();await new Promise(r=>setTimeout(r,20));
 const result=(await api('state')).data;assert.equal(result.accounts.length,1);assert(!JSON.stringify(result).includes('sample-secret'));assert.equal(result.messages.length,1);assert(calls>0);
 const accountId=result.accounts[0].id;
 const rpc=async(token,name,args={})=>{const r=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({id:1,jsonrpc:'2.0',method:'tools/call',params:{name,arguments:args}})});return{status:r.status,data:await r.json()};};
 assert.equal((await rpc('bad','search',{query:'Sample'})).status,401);
 assert.deepEqual(JSON.parse((await rpc(vault.state.mcpToken,'search',{query:'Sample'})).data.result.content[0].text),[]);
 await api('grant',{accountId,allowed:true});assert.equal(JSON.parse((await rpc(vault.state.mcpToken,'search',{query:'sample'})).data.result.content[0].text).length,1);
 await api('draft',{accountId,threadId:'t',text:'Draft'});assert.equal(vault.state.drafts.length,1);assert.equal((await api('send',{id:vault.state.drafts[0].id})).status,404);
 assert.equal((await api('draft',{accountId:'other',threadId:'t',text:'Hi'})).status,400);
 await api('thread',{accountId,threadId:'t',pinned:true,folder:'Work'});await b.sync();assert.equal(vault.state.messages.length,1);assert.equal(vault.state.threads[0].folder,'Work');
 const old=vault.state.mcpToken;await api('rotate-key',{});assert.equal((await rpc(old,'list_accounts')).status,401);
 await api('remove-account',{accountId});assert.equal(vault.state.accounts.length,0);assert.equal(vault.state.messages.length,0);assert.equal(vault.state.drafts.length,0);
 }finally{await b.close();rmSync(dir,{recursive:true});}
});
test('deleting an account while synchronizing cannot restore its data',async()=>{const dir=mkdtempSync(join(tmpdir(),'relay-race-'));const v=new Vault(dir,randomBytes(32));v.state.accounts.push({id:'a',adapter:'slack',service:'slack',name:'sample',config:{},aiAllowed:false});let release;const wait=new Promise(r=>release=r);const b=await startServer(v,resolve('ui'),{slack:{sync:async()=>{await wait;return{threads:[{id:'t',accountId:'a'}],messages:[]};}}});try{const pending=b.sync();v.state.accounts=[];release();await pending;assert.equal(v.state.threads.length,0);}finally{await b.close();rmSync(dir,{recursive:true});}});
test('Instagram login is asynchronous, stores only completed sessions, and rejects duplicates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-login-'));const v=new Vault(dir,randomBytes(32));let finish,forgot=0,calls=0;
 const b=await startServer(v,resolve('ui'),{instagram:{sync:async()=>({threads:[],messages:[]})}},{instagramLogin:()=>{calls++;return new Promise(r=>finish=r);},forget:async()=>{forgot++;}});
 try{
  b.beginInstagramLogin();b.beginInstagramLogin();assert.equal(calls,1);assert.equal(v.state.accounts.length,0);
  finish({id:'a',service:'instagram',adapter:'instagram',name:'Fixture',config:{viewerId:'owner',cookies:'secret-fixture'},aiAllowed:false});await new Promise(r=>setTimeout(r,20));
  assert.equal(v.state.accounts.length,1);assert.equal(v.state.accounts[0].aiAllowed,false);
  b.beginInstagramLogin();finish({id:'b',service:'instagram',adapter:'instagram',name:'Duplicate',config:{viewerId:'owner',cookies:'new-secret'},aiAllowed:false});await new Promise(r=>setTimeout(r,20));
  assert.equal(v.state.accounts.length,1);assert.equal(forgot,1);assert.equal(v.state.accounts[0].config.cookies,'secret-fixture');
 }finally{await b.close();rmSync(dir,{recursive:true});}
});
