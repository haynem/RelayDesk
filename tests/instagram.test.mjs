import test from 'node:test';import assert from 'node:assert/strict';
import {InstagramAdapter} from '../dist/adapters/instagram.js';
test('Instagram maps real-format API fixtures through GET-only reader and enforces viewer identity',async()=>{
 const calls=[];const raw={thread_id:'123',thread_title:'Fixture group',is_group:true,last_activity_at:'1700000000000000',users:[{pk:'peer',full_name:'Fixture Person'}],items:[{item_id:'m1',user_id:'peer',text:'Synthetic Instagram message',item_type:'text',timestamp:'1700000000000000'},{item_id:'m2',user_id:'me',is_sent_by_viewer:true,item_type:'media',media:{image_versions2:{candidates:[]}},timestamp:'1700000001000000'}]};
 const adapter=new InstagramAdapter(async(_account,path)=>{calls.push(path);if(path.includes('/inbox/'))return{status:'ok',viewer:{pk:'me'},inbox:{threads:[raw]}};return{status:'ok',thread:raw};});
 const result=await adapter.sync({id:'a',config:{viewerId:'me'}});assert.equal(result.threads[0].title,'Fixture group');assert.equal(result.messages.length,2);assert.equal(result.messages[0].sender,'Fixture Person');assert.equal(result.messages[0].ts,1700000000000);assert.equal(result.messages[1].isMe,true);assert.equal(result.messages[1].attachments[0].kind,'image');assert(calls.every(p=>!p.includes('/seen/')&&!p.includes('broadcast')));
 await assert.rejects(adapter.sync({id:'b',config:{viewerId:'other'}}));
});
