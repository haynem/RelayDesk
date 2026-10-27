import { key } from './model.js';
import { sensitive } from './notifications.js';
import { learningAdjustment } from './learning.js';
export function rankAttention(thread, message, now = Date.now(), learned) {
    let score = 50;
    const reasons = [];
    if (message.unavailable)
        reasons.push('本文未取得のため内容の優先度は推定しない');
    else if (!sensitive(message.text)) {
        if (/至急|緊急|本日|今日|明日|締切|urgent|deadline|asap/i.test(message.text)) {
            score += 20;
            reasons.push('期限・緊急の表現');
        }
        if (/お願い|相談|確認して|ご確認|返信|[?？]/.test(message.text)) {
            score += 10;
            reasons.push('依頼・質問の表現');
        }
        if (/配信停止|unsubscribe|ニュースレター|自動送信|キャンペーン/i.test(message.text)) {
            score -= 25;
            reasons.push('一斉配信・販促の表現');
        }
    }
    else
        reasons.push('機密情報の可能性があるため本文の優先度分析を除外');
    const age = Math.max(0, now - message.ts);
    if (age < 3600000) {
        score += 10;
        reasons.push('1時間以内の連絡');
    }
    else if (age < 86400000) {
        score += 5;
        reasons.push('24時間以内の連絡');
    }
    else if (age > 7 * 86400000) {
        score -= 10;
        reasons.push('7日より前の連絡');
    }
    if (thread.priority) {
        score += thread.priority * 15;
        reasons.push('会話に指定した重要度');
    }
    if (thread.priority === 2)
        score = Math.max(85, score);
    if (learned) {
        score += learned.delta;
        reasons.push(...learned.reasons);
        if (learned.forceHigh)
            score = Math.max(85, score);
    }
    const autoScore = Math.max(0, Math.min(100, score)), autoIndex = autoScore >= 75 ? 2 : autoScore < 40 ? 0 : 1;
    const levels = ['low', 'medium', 'high'], feedback = Math.max(-2, Math.min(2, thread.priorityFeedback || 0));
    const index = Math.max(0, Math.min(2, autoIndex + feedback));
    if (feedback)
        reasons.push('あなたの調整：' + Math.abs(feedback) + '段階' + (feedback > 0 ? '上げる' : '下げる'));
    score = index === 0 ? Math.min(39, autoScore) : index === 1 ? Math.max(40, Math.min(74, autoScore)) : Math.max(75, autoScore);
    if (!reasons.length)
        reasons.push('手掛かりが少ないため通常評価');
    return { score, level: levels[index], autoLevel: levels[autoIndex], autoScore, reasons, feedback };
}
export function buildAttentionQueue(state, now = Date.now()) {
    const latest = new Map(), incoming = new Map();
    for (const m of state.messages) {
        if (m.deleted)
            continue;
        const k = key(m.accountId, m.threadId);
        if (!latest.has(k) || latest.get(k).ts <= m.ts)
            latest.set(k, m);
        if (!m.isMe && (!incoming.has(k) || incoming.get(k).ts <= m.ts))
            incoming.set(k, m);
    }
    const sent = new Map();
    for (const d of state.drafts)
        if (d.status === 'sent')
            sent.set(key(d.accountId, d.threadId), Math.max(sent.get(key(d.accountId, d.threadId)) || 0, d.sentAt || 0));
    return state.threads.flatMap(thread => {
        const k = key(thread.accountId, thread.id), m = incoming.get(k);
        if (!m && !thread.bodyUnavailable && thread.sourceUnread !== true)
            return [];
        // A thread-only notice is not inserted into the message store or counted as a real message.
        const preview = m || { id: '@thread', accountId: thread.accountId, threadId: thread.id, text: '本文は未取得です。元のサービス画面で確認してください。', sender: '本文未取得', ts: thread.updatedAt, isMe: false, attachments: [], unavailable: true };
        const locallySeen = m ? (thread.localSeenAt || 0) > m.ts || ((thread.localSeenAt || 0) === m.ts && thread.localSeenMessageId === m.id) : thread.localSeenMessageId === '@thread' && (thread.localSeenAt || 0) >= preview.ts;
        const answered = (sent.get(k) || 0) > 0 && preview.ts > 0 && (sent.get(k) || 0) >= preview.ts;
        const localCandidate = m ? !latest.get(k)?.isMe : !!thread.bodyUnavailable;
        const snoozed = (thread.snoozedUntil || 0) > now;
        const pending = !snoozed && !locallySeen && !answered && (thread.sourceUnread === true || (thread.sourceUnread === undefined && localCandidate));
        return [{ accountId: thread.accountId, threadId: thread.id, messageId: m?.id ?? null, bodyUnavailable: !m || !!m.unavailable, ts: preview.ts, text: preview.text, sender: preview.sender, title: thread.title, sourceUnread: thread.sourceUnread, sourceUnreadCount: thread.sourceUnreadCount, locallySeen, pending, snoozed, snoozedUntil: thread.snoozedUntil, ...rankAttention(thread, preview, now, learningAdjustment(state, thread, preview, now)) }];
    }).sort((a, b) => b.score - a.score || b.ts - a.ts || key(a.accountId, a.threadId).localeCompare(key(b.accountId, b.threadId)));
}
