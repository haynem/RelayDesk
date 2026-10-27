import {createInterface} from 'node:readline';
const url=process.env.RELAY_MCP_URL||'';const token=process.env.RELAY_MCP_TOKEN||'';
if(!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)||!token){process.stderr.write('RelayDeskのAI接続画面でURLとキーを確認し、環境変数を設定してください。\n');process.exit(1);}
for await(const line of createInterface({input:process.stdin})){try{const value=JSON.parse(line);const res=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(value),redirect:'error'});if(value.id!==undefined){const body=await res.json();process.stdout.write(JSON.stringify(body)+'\n');}}catch{process.stderr.write('MCP接続エラー（本文・キーはログに出力しません）。\n');}}
