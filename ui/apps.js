let active=null,visible=false,lastContext=null,lastRoot=null;
export function leaveApps(){if(visible&&lastContext)void lastContext.api('hide-service',{}).catch(()=>{});visible=false;}
function bounds(root){const frame=root.querySelector('#service-frame');if(!frame)return null;const r=frame.getBoundingClientRect();frame.style.height=Math.max(240,window.innerHeight-r.top-20)+'px';const b=frame.getBoundingClientRect();return{x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)};}
window.addEventListener('resize',()=>{if(active&&visible&&lastRoot&&lastContext?.isActive()){const box=bounds(lastRoot);if(box)void lastContext.api('service-bounds',{bounds:box}).catch(()=>{});}});
export function renderApps(root,context){
  const {state,esc,names,api,notify,openConnect,openInbox,newEmail,isActive=()=>true}=context;lastContext={...context,isActive};lastRoot=root;
  if(active?.accountId&&!state.accounts.some(a=>a.id===active.accountId)){active=null;visible=false;void api('hide-service',{}).catch(()=>{});}
  if(active){
    document.body.classList.add('native-active');
    root.innerHTML='<div class="service-bar"><div><strong>'+esc(names[active.service])+' · 元のサービス画面</strong><small>この画面では元サービスの既読・送信動作に従います。</small></div><div class="attention-actions"><button id="workspace-back">アプリ一覧に戻る</button><button id="workspace-reload">再読み込み</button><button id="workspace-window">別ウィンドウで開く</button></div></div><div id="service-frame">サービスの画面を読み込んでいます…</div>';
    const box=bounds(root),current=active;
    root.querySelector('#workspace-back').onclick=async()=>{await api('hide-service',{});visible=false;active=null;document.body.classList.remove('native-active');renderApps(root,context);};
    root.querySelector('#workspace-reload').onclick=()=>api('reload-service',{}).catch(e=>notify(e.message));
    root.querySelector('#workspace-window').onclick=async()=>{await api('hide-service',{});visible=false;active=null;document.body.classList.remove('native-active');renderApps(root,context);await api('open-service',{service:current.service,accountId:current.accountId,acknowledgeReadEffects:true});};
    if(!visible){visible=true;void api('open-service',{service:current.service,accountId:current.accountId,acknowledgeReadEffects:true,bounds:box}).then(()=>{if(!isActive()||active!==current){visible=false;return api('hide-service',{});}}).catch(e=>{visible=false;notify(e.message);});}
    else if(box)void api('service-bounds',{bounds:box}).catch(()=>{});
    return;
  }
  document.body.classList.remove('native-active');
  root.innerHTML=`<div class="panel"><h2>サービスごとの画面で操作する</h2><p>新規メッセージ、グループ操作、リアクション、ファイル送信などは元のサービス画面から操作できます。対応するWeb版はRelayDesk内で表示します。LINEとGmailは公式アプリ・ブラウザーへ進みます。</p><p class="muted">元のサービス画面では、そのサービスの既読・送信動作に従います。統合一覧へのデータ取得が未接続でも、元の画面で操作できる場合があります。サービス固有の機能にはWeb版・PC版自体の制限が適用されます。</p></div><div class="cards">${Object.entries(names).map(([service,name])=>{const accounts=state.accounts.filter(a=>a.service===service);return`<section class="card app-card"><h2>${name}</h2>${accounts.length?accounts.map(a=>`<div class="app-account"><strong>${esc(a.name)}</strong><p class="muted">${a.lastSync?'統合データを取得済み':'統合データの取得は未完了'}${a.error?' · 要確認':''}</p><div class="attention-actions"><button data-service-open="${service}" data-account="${esc(a.id)}">${service==='line'?'公式LINEを開く':service==='email'?'Webメールを開く':'元のサービス画面を開く'}</button><button data-app-inbox="${esc(a.id)}">統合した会話を見る</button>${service==='email'&&a.canSend?`<button data-email-compose="${esc(a.id)}">新規メールを作成</button>`:''}</div></div>`).join(''):'<p class="muted">統合データの接続は未設定です。</p><button data-service-open="'+service+'">元のサービス画面を開く</button>'}<button data-app-connect="${service}">アカウントを追加</button></section>`;}).join('')}</div>`;
  root.querySelectorAll('[data-service-open]').forEach(b=>b.onclick=async()=>{if(!confirm('元のサービス画面を開きます。\n\nこの画面では元サービスの動作に従い、閲覧で既読になる場合があります。送信・削除などは、あなたが元の画面で操作した内容が実行されます。\n\n開きますか？'))return;try{const service=b.dataset.serviceOpen,accountId=b.dataset.account||undefined;if(['line','email'].includes(service)){await api('open-service',{service,accountId,acknowledgeReadEffects:true});notify('公式アプリ・ブラウザーを開きました。');}else{active={service,accountId};visible=false;renderApps(root,context);}}catch(e){notify(e.message);}});
  root.querySelectorAll('[data-app-connect]').forEach(b=>b.onclick=()=>openConnect(b.dataset.appConnect));
  root.querySelectorAll('[data-app-inbox]').forEach(b=>b.onclick=()=>openInbox(b.dataset.appInbox));
  root.querySelectorAll('[data-email-compose]').forEach(b=>b.onclick=()=>newEmail(b.dataset.emailCompose));
}

