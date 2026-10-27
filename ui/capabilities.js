export async function renderCapabilities(root,{api,esc,notify}){
  try{const data=await api('capabilities');if(!root.isConnected)return;const fields=[['read','取得'],['history','履歴'],['send','返信・新規送信'],['files','添付'],['actions','メッセージ操作'],['members','参加者'],['receipts','既読'],['remaining','残っている制約']];
    root.innerHTML=`<div class="panel"><h2>PC版の実装状況</h2><p>この表は現在のコードの対応範囲です。今回追加した機能は、指定に従い動作テストを挟まずに実装しています。サービス全体の完全対応・実動作確認済みを意味するものではありません。</p><h3>共通機能</h3><ul>${data.shared.map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div><div class="cards">${data.services.map(s=>`<section class="card"><h2>${esc(s.name)}</h2><dl>${fields.map(([key,label])=>`<dt>${label}</dt><dd>${esc(s[key])}</dd>`).join('')}</dl></section>`).join('')}</div><div class="panel"><h2>全要件の完成までに残る項目</h2><ul>${data.outstanding.map(s=>`<li>${esc(s)}</li>`).join('')}</ul><p>Androidの他アプリ通知収集・iOS等の開発は、PC版を優先する現在の作業から切り離しています。</p></div>`;
  }catch(error){notify(error.message);}
}
