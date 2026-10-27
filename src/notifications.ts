export type Observations={count:number; opened:number; dismissed:number; replied:number; meanOpenMs?:number; days:number};
export function sensitive(text:string){return /\b(?:otp|password|passcode|verification|authentication)\b|認証|確認コード|ワンタイム|パスワード|暗証番号|\b\d{4,8}\b/i.test(text);}
export function scoreNotification(text:string,o:Observations,priority=false,keywords:string[]=[]){
  if(sensitive(text))return {level:'excluded',score:0,reasons:['機密情報の可能性があるため分析・保存から除外']};
  const reasons:string[]=[];let score=50;
  if(priority||keywords.some(k=>k.trim()&&text.toLowerCase().includes(k.toLowerCase())))return{level:'high',score:100,reasons:['ユーザーが指定した優先対象']};
  if(/至急|緊急|締切|お願い|urgent|deadline/i.test(text)){score+=25;reasons.push('依頼・緊急キーワード');}
  if(o.count<20||o.days<7)reasons.push('観測不足のため通常通知を維持');
  else {if(o.opened/o.count>=.5){score+=20;reasons.push('閲覧率が高い');}if(o.replied>0){score+=15;reasons.push('返信実績');}if(o.opened>0&&o.meanOpenMs!==undefined&&o.meanOpenMs<120000){score+=10;reasons.push('確認までの時間が短い');}if(o.dismissed/o.count>.8&&o.opened/o.count<.1&&o.replied===0){score-=15;reasons.push('消去が多い（消去だけでは低評価にしない）');}if(o.count/o.days>30&&o.opened/o.count<.1&&o.replied===0){score-=20;reasons.push('大量通知かつ閲覧実績が少ない');}}
  score=Math.max(0,Math.min(100,score));return{level:score>=75?'high':score<35?'low':'medium',score,reasons};
}
