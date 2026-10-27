import type {Account,Adapter,Message,State,Thread} from './model.js';
/** Receipt writes are separate from fetching. Only an account's explicit opt-in enables them. */
export async function sendReadReceipt(state:State,adapters:Record<string,Adapter>,account:Account,thread:Thread,message:Message,reason:'opened'|'sent',save:()=>void){
  const mode=account.readMode||'never',adapter=adapters[account.adapter];
  if(mode==='never'||reason==='opened'&&mode!=='always'||!adapter?.markRead||message.deleted||message.unavailable||message.isMe)return{sent:false};
  try{await adapter.markRead(account,thread,message);account.receiptError=false;save();return{sent:true};}
  catch{account.receiptError=true;save();return{sent:false,uncertain:true};}
}
