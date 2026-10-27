import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {X509Certificate} from 'node:crypto';
import {MobileGateway} from '../dist/mobile.js';
import {Outbox} from '../dist/outbox.js';
test('mobile TLS pairing restricts accounts, excludes credentials, stages drafts only and revokes access',async()=>{
  const state={accounts:['a','b'].map(id=>({id,service:'line',name:'fixture '+id,config:{token:'PRIVATE-FIXTURE'},aiAllowed:false})),threads:['a','b'].map(accountId=>({id:'t',accountId,title:'fixture thread'})),messages:['a','b'].map(accountId=>({id:'m',accountId,threadId:'t',text:'fixture message'})),drafts:[]};
  let saves=0;const gateway=new MobileGateway(state,()=>saves++);
  assert.equal(gateway.status().enabled,false);
  await assert.rejects(()=>gateway.pair(['nonexistent'],'fixture'));
  const pairing=await gateway.pair(['a'],'fixture Android');
  const request=(token,path='/mobile/v1/snapshot',body)=>new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',agent:false,port:pairing.port,path,method:body?'POST':'GET',ca:state.mobileTLS.cert,headers:{Authorization:'Bearer '+token}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  try{
    assert.equal(pairing.fingerprint,new X509Certificate(state.mobileTLS.cert).fingerprint256.replace(/:/g,'').toLowerCase());
    assert.equal((await request('invalid')).status,401);
    const snapshot=await request(pairing.token);assert.equal(snapshot.status,200);assert.equal(snapshot.body.accounts.length,1);assert.equal(snapshot.body.messages.length,1);assert.equal(snapshot.body.accounts[0].id,'a');assert.ok(!JSON.stringify(snapshot).includes('PRIVATE-FIXTURE'));
    assert.ok(!JSON.stringify(gateway.status()).includes(pairing.token));assert.ok(!JSON.stringify(state).includes(pairing.token));
    assert.equal((await request(pairing.token,'/mobile/v1/drafts',{accountId:'b',threadId:'t',text:'blocked'})).status,403);
    const result=await request(pairing.token,'/mobile/v1/drafts',{accountId:'a',threadId:'t',text:'synthetic draft'});assert.equal(result.status,201);assert.equal(result.body.sent,false);assert.equal(state.drafts[0].status,'pending');
    assert.equal((await request(pairing.token,'/mobile/v1/send',{})).status,404);
    gateway.revoke(pairing.deviceId);assert.equal((await request(pairing.token)).status,401);assert.ok(saves>=3);
  }finally{await gateway.stop();}
});
test('mobile sends require a device grant and a one-use concrete approval; pairing survives PC restart',async()=>{
  const state={accounts:[{id:'a',adapter:'slack',service:'slack',name:'fixture',config:{}}],threads:[{id:'t',accountId:'a',title:'fictional recipient'}],messages:[],drafts:[{id:'d',accountId:'a',threadId:'t',text:'synthetic message',status:'pending'}]};
  let writes=0;const outbox=new Outbox(state,{slack:{sendText:async()=>{writes++;return{id:'synthetic remote id'};}}},()=>{});
  let gateway=new MobileGateway(state,()=>{},outbox);
  const readOnly=await gateway.pair(['a'],'read only');const writer=await gateway.pair(['a'],'writer',true);
  const request=(token,path,body)=>new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',agent:false,port:writer.port,path,method:body?'POST':'GET',ca:state.mobileTLS.cert,headers:{Authorization:'Bearer '+token}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  try{
    assert.equal((await request(readOnly.token,'/mobile/v1/prepare-send',{draftId:'d'})).status,403);
    const prepared=await request(writer.token,'/mobile/v1/prepare-send',{draftId:'d'});assert.equal(prepared.status,200);assert.equal(prepared.body.preview.recipient,'fictional recipient');assert.equal(writes,0);
    assert.equal((await request(writer.token,'/mobile/v1/approve-send',{draftId:'d',challenge:prepared.body.challenge,explicitConfirmation:false})).status,400);assert.equal(writes,0);
    const next=await request(writer.token,'/mobile/v1/prepare-send',{draftId:'d'});
    assert.equal((await request(writer.token,'/mobile/v1/approve-send',{draftId:'d',challenge:next.body.challenge,explicitConfirmation:true})).status,200);assert.equal(writes,1);
    assert.equal((await request(writer.token,'/mobile/v1/approve-send',{draftId:'d',challenge:next.body.challenge,explicitConfirmation:true})).status,400);assert.equal(writes,1);
    await gateway.stop();gateway=new MobileGateway(state,()=>{},outbox);await gateway.restore();assert.equal(gateway.status().port,writer.port);assert.equal((await request(writer.token,'/mobile/v1/snapshot')).status,200);
    await gateway.stop(true);gateway=new MobileGateway(state,()=>{},outbox);await gateway.restore();assert.equal(gateway.status().enabled,false);
  }finally{await gateway.stop(true);}
});
