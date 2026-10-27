export function bindMessageAssets(root,messages,{api,fetchBlob,notify}){
  root.querySelectorAll('[data-attachment]').forEach(button=>button.onclick=async()=>{
    const [mi,index]=button.dataset.attachment.split(':').map(Number),message=messages[mi];if(!message)return;button.disabled=true;
    try{const asset=await api('download-attachment',{accountId:message.accountId,threadId:message.threadId,messageId:message.id,index});await showAsset(asset,{accountId:message.accountId,threadId:message.threadId,messageId:message.id,assetId:asset.assetId},{api,fetchBlob,notify});}catch(error){notify(error.message);}finally{button.disabled=false;}
  });
}
export async function showAsset(asset,reference,{api,fetchBlob,notify}){
  const modal=document.createElement('dialog'),title=document.createElement('h2');title.textContent=asset.name;modal.append(title);
  const metadata=document.createElement('p');metadata.textContent=asset.mime+' · '+Math.ceil(asset.size/1024)+' KB';modal.append(metadata);
  let objectUrl;const preview=['image/png','image/jpeg','image/gif','image/webp','image/avif'].includes(asset.mime)?'img':asset.mime.startsWith('video/')?'video':asset.mime.startsWith('audio/')?'audio':null;
  if(preview){const response=await fetchBlob('asset',reference);objectUrl=URL.createObjectURL(response);const media=document.createElement(preview);media.src=objectUrl;if(preview==='img')media.alt=asset.name;else media.controls=true;media.className='asset-preview';modal.append(media);}
  else{const info=document.createElement('p');info.textContent='この形式はファイルに保存して確認できます。';modal.append(info);}
  const save=document.createElement('button');save.textContent='名前を付けて保存';save.onclick=async()=>{try{const result=await api('export-asset',reference);if(result.saved)notify('ファイルを保存しました。');}catch(error){notify(error.message);}};
  const close=document.createElement('button');close.textContent='閉じる';close.onclick=()=>modal.close();modal.append(save,close);modal.addEventListener('close',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);modal.remove();});document.body.append(modal);modal.showModal();
}
export function bindDraftAssets(root,{state,api,notify,refresh,fetchBlob}){
  root.querySelectorAll('[data-pick-draft-files]').forEach(button=>button.onclick=async()=>{const draft=state.drafts.find(d=>d.id===button.dataset.pickDraftFiles);if(!draft)return;try{await api('pick-draft-files',{accountId:draft.accountId,threadId:draft.threadId,draftId:draft.id});await refresh();}catch(error){notify(error.message);}});
  root.querySelectorAll('[data-remove-draft-file]').forEach(button=>button.onclick=async()=>{try{await api('remove-draft-file',{draftId:button.dataset.draft,assetId:button.dataset.removeDraftFile});await refresh();}catch(error){notify(error.message);}});
  root.querySelectorAll('[data-preview-draft-file]').forEach(button=>button.onclick=async()=>{const draft=state.drafts.find(d=>d.id===button.dataset.draft),asset=state.assets.find(a=>a.id===button.dataset.previewDraftFile&&a.draftId===draft?.id);if(!draft||!asset)return;try{await showAsset({...asset,assetId:asset.id},{accountId:draft.accountId,draftId:draft.id,assetId:asset.id},{api,fetchBlob,notify});}catch(error){notify(error.message);}});
}
