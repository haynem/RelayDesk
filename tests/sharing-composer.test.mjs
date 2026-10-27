import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Vault} from '../dist/vault.js';
import {startServer} from '../dist/server.js';
import {mcp} from '../dist/mcp.js';
import {createComposerStore} from '../ui/composer.js';
const call=(s,name,args={})=>mcp(s,{id:1,method:'tools/call',params:{name,arguments:args}});
test('selected-conversation sharing filters every MCP read and draft tool and revocation is immediate',()=>{
  const now=Date.now(),s={accounts:[{id:'a',aiAllowed:true,aiScope:'selected',aiThreadIds:['shared']},{id:'b',aiAllowed:false}],threads:[{accountId:'a',id:'shared',title:'shared',members:[],updatedAt:now},{accountId:'a',id:'private',title:'PRIVATE-TITLE',members:[],updatedAt:now},{accountId:'b',id:'shared',title:'OTHER-ACCOUNT',members:[],updatedAt:now}],messages:[{accountId:'a',threadId:'shared',id:'one',text:'meeting shared',ts:now,isMe:false,attachments:[]},{accountId:'a',threadId:'private',id:'two',text:'meeting PRIVATE-BODY',ts:now,isMe:false,attachments:[]},{accountId:'b',threadId:'shared',id:'three',text:'meeting OTHER-BODY',ts:now,isMe:false,attachments:[]}],drafts:[],draftAllowed:true};
  for(const tool of ['list_threads','search','list_attention']){const result=JSON.stringify(call(s,tool,{query:'meeting'}));assert(!result.includes('PRIVATE'));assert(!result.includes('OTHER'));assert(result.includes('shared'));}
  for(const tool of ['get_messages','list_members','stage_reply'])assert(call(s,tool,{accountId:'a',threadId:'private',text:'fixture'}).error);
  assert(!call(s,'stage_reply',{accountId:'a',threadId:'shared',text:'fixture'}).error);assert.equal(s.drafts.length,1);
  s.accounts[0].aiAllowed=false;assert(call(s,'get_messages',{accountId:'a',threadId:'shared'}).error);assert.deepEqual(JSON.parse(call(s,'list_attention').result.content[0].text),[]);
});
test('editable replies persist encrypted, remain separate per account, and never send or grant access',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-composer-')),secret=randomBytes(32),vault=new Vault(dir,secret);
  vault.state.accounts=[{id:'a',service:'email',adapter:'imap',name:'fixture',config:{},aiAllowed:false},{id:'b',service:'email',adapter:'imap',name:'fixture2',config:{},aiAllowed:false}];
  vault.state.threads=['a','b'].map(accountId=>({accountId,id:'same',title:'fixture',isGroup:false,updatedAt:1,members:[],membersComplete:false}));
  const backend=await startServer(vault,resolve('ui'),{}),api=async(path,data)=>{const response=await fetch(`http://127.0.0.1:${backend.port}/api/${path}`,{method:'POST',headers:{'X-Relay-Session':backend.session,'Content-Type':'application/json'},body:JSON.stringify(data)});return{status:response.status,data:await response.json()};};
  try{
    const content='PRIVATE-EDITABLE-REPLY';assert.equal((await api('composer',{accountId:'a',threadId:'same',text:content})).status,200);
    await api('composer',{accountId:'b',threadId:'same',text:'other'});
    assert(!readFileSync(join(dir,'state.enc')).includes(content));assert.equal(new Vault(dir,secret).state.composerDrafts.length,2);assert.equal(vault.state.drafts.length,0);
    assert.equal((await api('composer',{accountId:'unknown',threadId:'same',text:'no'})).status,400);
    assert.equal((await api('grant',{accountId:'a',allowed:true,scope:'selected',threadIds:['foreign']})).status,400);assert.equal(vault.state.accounts[0].aiAllowed,false);
    await api('draft',{accountId:'a',threadId:'same',text:content});assert.equal(vault.state.composerDrafts.length,1);assert.equal(vault.state.composerDrafts[0].accountId,'b');assert.equal(vault.state.drafts[0].status,'pending');
    await api('remove-account',{accountId:'b'});assert.equal(vault.state.composerDrafts.length,0);
  }finally{await backend.close();rmSync(dir,{recursive:true});}
});
test('composer serialization preserves newest text across slow saves and refresh, and clearing cannot resurrect it',async()=>{
  let release;const writes=[],api=async(_path,value)=>{writes.push(value.text);if(writes.length===1)await new Promise(resolve=>release=resolve);};
  const store=createComposerStore(api,()=>{}),thread={accountId:'a',id:'t'},state={composerDrafts:[{accountId:'a',threadId:'t',text:'restored'}]};
  assert.equal(store.text(thread,state),'restored');store.update(thread,state,'first');const first=store.flush(thread,state);await new Promise(resolve=>setTimeout(resolve,0));
  store.update(thread,state,'newest');const second=store.flush(thread,state);assert.equal(store.text(thread,{composerDrafts:[]}),'newest');release();await Promise.all([first,second]);assert.deepEqual(writes,['first','newest']);
  store.clear(thread,state);assert.equal(store.text(thread,state),'');await store.flushAll();assert.deepEqual(writes,['first','newest']);store.forgetMissing([]);
});
