// Keep editable text across UI refreshes; persist only through the encrypted local backend.
export function createComposerStore(api,onError){
  const entries=new Map();
  const key=t=>JSON.stringify([t.accountId,t.id]);
  function entry(thread,state){
    const id=key(thread);if(!entries.has(id)){const saved=(state.composerDrafts||[]).find(d=>d.accountId===thread.accountId&&d.threadId===thread.id);entries.set(id,{accountId:thread.accountId,threadId:thread.id,text:saved?.text||'',replyTo:saved?.replyTo,replyAll:saved?.replyAll===true,dirty:false,timer:null,queue:Promise.resolve()});}
    return entries.get(id);
  }
  async function flushEntry(e){
    clearTimeout(e.timer);if(!e.dirty)return e.queue;
    const text=e.text,replyTo=e.replyTo,replyAll=e.replyAll;e.dirty=false;
    const pending=e.queue.catch(()=>{}).then(()=>api('composer',{accountId:e.accountId,threadId:e.threadId,text,replyTo,replyAll}));
    e.queue=pending;
    try{await pending;}catch(error){if(e.text===text&&e.replyTo===replyTo)e.dirty=true;throw error;}
  }
  return{
    text:(t,state)=>entry(t,state).text,
    replyTo:(t,state)=>entry(t,state).replyTo,
    replyAll:(t,state)=>entry(t,state).replyAll,
    setReplyAll(t,state,value){const e=entry(t,state);e.replyAll=value;e.dirty=true;clearTimeout(e.timer);e.timer=setTimeout(()=>void flushEntry(e).catch(error=>onError(error.message)),350);},
    quote(t,state,replyTo){const e=entry(t,state);e.replyTo=replyTo;e.dirty=true;clearTimeout(e.timer);e.timer=setTimeout(()=>void flushEntry(e).catch(error=>onError(error.message)),350);},
    update(t,state,text){const e=entry(t,state);e.text=text;e.dirty=true;clearTimeout(e.timer);e.timer=setTimeout(()=>void flushEntry(e).catch(error=>onError(error.message)),350);},
    flush:(t,state)=>flushEntry(entry(t,state)),
    clear(t,state){const e=entry(t,state);clearTimeout(e.timer);e.text='';e.replyTo=undefined;e.replyAll=false;e.dirty=false;},
    flushAll:()=>Promise.all([...entries.values()].map(flushEntry)),
    forgetMissing(accounts){for(const [id,e]of entries)if(!accounts.some(a=>a.id===e.accountId)){clearTimeout(e.timer);entries.delete(id);}}
  };
}
