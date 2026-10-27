import {Notification} from 'electron';
import {key} from './model.js';
import type {NotificationTarget} from './desktop-notification-policy.js';
export class DesktopNotifications{
  private pending=new Map<string,NotificationTarget>();private timer?:ReturnType<typeof setTimeout>;private shown=new Set<Notification>();
  constructor(private open:()=>void){}
  supported(){return Notification.isSupported();}
  test(){
    if(!this.supported())throw Error('この環境ではPC通知を利用できません');
    const toast=new Notification({title:'RelayDesk · 通知テスト',body:'通知の動作確認です。クリックすると連絡一覧を開きます。'});
    this.shown.add(toast);toast.on('click',()=>{this.open();toast.close();});toast.on('close',()=>this.shown.delete(toast));toast.on('failed',()=>this.shown.delete(toast));toast.show();
  }
  enqueue(targets:NotificationTarget[]){
    if(!this.supported())return;
    for(const target of targets)this.pending.set(key(target.accountId,target.threadId),target);
    if(!targets.length||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=undefined;const items=[...this.pending.values()];this.pending.clear();if(!items.length)return;
      const high=items.filter(i=>i.level==='high').length;
      // Names, message text, account identities and secrets never enter OS notification history.
      const toast=new Notification({title:'RelayDesk',body:'新しい連絡が'+items.length+'会話あります。'+(high?' 優先度「高」：'+high+'会話。':'')+' 開いて確認できます。',silent:items.every(i=>i.level==='low')});
      this.shown.add(toast);toast.on('click',()=>{this.open();toast.close();});toast.on('close',()=>this.shown.delete(toast));toast.on('failed',()=>this.shown.delete(toast));toast.show();
    },1500);
  }
  clear(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.pending.clear();for(const toast of this.shown)toast.close();this.shown.clear();}
}
