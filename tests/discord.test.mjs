import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DiscordAdapter} from '../dist/adapters/discord.js';
test('Discord integration uses Bot authorization for read endpoints and refuses personal tokens before networking',async()=>{
  let requests=0;const server=createServer((req,res)=>{requests++;assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bot fixture');const data=req.url==='/users/@me'?{id:'self',bot:true}:req.url==='/channels/123'?{id:'123',name:'fixture',type:0}:[{id:'m',timestamp:'2026-10-27T00:00:00Z',content:'Synthetic fixture',author:{id:'other',username:'Fixture'},attachments:[]}];res.end(JSON.stringify(data));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const adapter=new DiscordAdapter(`http://127.0.0.1:${server.address().port}/`);await assert.rejects(adapter.sync({id:'a',config:{mode:'user',token:'fixture'}}),/公式Bot/);assert.equal(requests,0);const batch=await adapter.sync({id:'a',config:{mode:'bot',token:'fixture',channels:'123'}});assert.equal(batch.messages.length,1);assert.equal(batch.threads[0].title,'fixture');assert.equal(requests,3);}finally{await new Promise(resolve=>server.close(resolve));}
});
