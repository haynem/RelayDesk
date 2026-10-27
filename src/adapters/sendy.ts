import type {Account, Adapter, Batch} from '../model.js';
export class SendyAdapter implements Adapter {
  async sync(a:Account):Promise<Batch>{
    const port=Number(a.config.port||8765);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
    const call=async(name:string,args:object)=>{
      // Never invoke send_reply, markRead or mutate Sendy settings.
      if(!['list_threads','get_messages'].includes(name))throw Error('Read-only adapter');
      const r=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${a.config.token}`,'Content-Type':'application/json','X-Client-Name':'RelayDesk-readonly'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(30000),redirect:'error'});
      if(!r.ok)throw Error('Sendyを起動し、AI接続のポートと読み取り用キーを確認してください。');const data=await r.json() as any;
      if(data.error||data.result?.isError)throw Error('Sendy読み取り権限または接続を確認してください。');return JSON.parse(data.result.content[0].text);
    };
    const threads=await call('list_threads',{accountId:a.config.remoteAccountId,network:a.service,limit:100});const batch:Batch={threads:[],messages:[]};
    for(const t of threads){if(t.accountId!==a.config.remoteAccountId)continue;const messages=await call('get_messages',{accountId:t.accountId,threadId:t.id,limit:100});batch.threads.push({id:t.id,accountId:a.id,title:t.title||t.id,isGroup:!!t.isGroup,updatedAt:t.lastActivityTs||0,members:[...new Set<string>(messages.map((m:any)=>String(m.senderName||'不明')))],membersComplete:false});batch.messages.push(...messages.map((m:any)=>({id:String(m.id),threadId:t.id,accountId:a.id,sender:m.senderName||'不明',text:m.text||'',ts:m.ts||0,isMe:!!m.isMe,attachments:(m.attachments||[]).map((kind:string)=>({name:kind,kind})),replyTo:m.replyToId})));}
    return batch;
  }
}
