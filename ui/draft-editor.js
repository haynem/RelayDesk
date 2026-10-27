export function bindDraftEditor(root,{state,api,notify,refresh,esc}){
  root.querySelectorAll('[data-discard-draft]').forEach(button=>button.onclick=async()=>{
    if(!confirm('このアプリに保存した未送信の返信案を取り消しますか？ 元サービスのメッセージは変更しません。'))return;
    button.disabled=true;try{await api('discard-draft',{draftId:button.dataset.discardDraft});await refresh();}catch(error){notify(error.message);button.disabled=false;}
  });
  root.querySelectorAll('[data-edit-draft]').forEach(button=>button.onclick=()=>{
    const draft=state.drafts.find(d=>d.id===button.dataset.editDraft);if(!draft)return;
    const modal=document.createElement('dialog');modal.innerHTML='<form><h2>返信案を編集</h2><p class="muted">編集しても送信しません。送信時には変更後の本文を確認します。</p><textarea name="text" '+(draft.fileIds?.length?'':'required')+' maxlength="10000" rows="8">'+esc(draft.text)+'</textarea><p data-error role="alert"></p><div class="attention-actions"><button type="button" data-close>戻る</button><button type="submit" class="primary">変更を保存</button></div></form>';
    document.body.append(modal);modal.querySelector('[data-close]').onclick=()=>modal.close();modal.addEventListener('close',()=>modal.remove());
    modal.querySelector('form').onsubmit=async event=>{event.preventDefault();try{await api('update-draft',{draftId:draft.id,text:modal.querySelector('textarea').value});modal.close();await refresh();}catch(error){modal.querySelector('[data-error]').textContent=error.message;}};modal.showModal();
  });
}
