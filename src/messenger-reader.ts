import {spawn} from 'node:child_process';
export function readMessenger(helper:string,input:unknown):Promise<any>{
  return new Promise((resolve,reject)=>{
    const child=spawn(helper,[],{windowsHide:true,stdio:['pipe','pipe','ignore']});let output='';let settled=false;
    child.stdout.setEncoding('utf8');
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(value);};
    const timer=setTimeout(()=>finish(Error('Messenger timeout')),(typeof input==='object'&&input!==null&&(input as any).mode!=='read'?195000:65000));
    child.on('error',()=>finish(Error('Messenger helper_unavailable')));
    child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(Buffer.byteLength(output)>35*1024*1024)finish(Error('Messenger response_too_large'));});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{if(code!==0)return finish(Error('Messenger helper_failed'));try{const data=JSON.parse(output);if(!data.ok)return finish(Error('Messenger '+(['missing_cookies','identity_mismatch','timeout','schema_changed'].includes(data.error)?data.error:'read_failed')));finish(undefined,data);}catch{finish(Error('Messenger invalid_response'));}});
    child.stdin.end(JSON.stringify(input));
  });
}
