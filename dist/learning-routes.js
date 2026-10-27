import { learningState, learningSummary, observeLearning, setLocalRule, actOnProposal, undoLocalRule, pruneLearning } from './learning.js';
export function learningRoute(state, path, input) {
    if (path === '/api/observe') {
        if (!['opened', 'expanded'].includes(input.kind))
            throw Error('観測する操作が無効です');
        const message = state.messages.find(m => m.accountId === input.accountId && m.threadId === input.threadId && m.id === input.messageId);
        if (!message)
            throw Error('メッセージがありません');
        return { recorded: observeLearning(state, input.kind, message), remoteChanged: false };
    }
    if (path === '/api/attention-snooze') {
        const thread = state.threads.find(t => t.accountId === input.accountId && t.id === input.threadId);
        if (!thread)
            throw Error('会話がありません');
        if (![0, 3600000, 86400000].includes(input.duration))
            throw Error('後で確認する時間が無効です');
        thread.snoozedUntil = input.duration ? Date.now() + input.duration : undefined;
        if (input.duration) {
            const latest = state.messages.filter(m => m.accountId === thread.accountId && m.threadId === thread.id && !m.isMe).sort((a, b) => b.ts - a.ts)[0];
            observeLearning(state, 'dismissed', latest);
        }
        return { ok: true, remoteChanged: false };
    }
    if (path === '/api/learning-settings') {
        if (typeof input.enabled !== 'boolean' || !Array.isArray(input.disabledAccounts) || input.disabledAccounts.some((id) => !state.accounts.some(a => a.id === id)) || !Array.isArray(input.keywords) || input.keywords.length > 50 || input.keywords.some((k) => typeof k !== 'string' || k.length > 80) || ![7, 30, 90, 180, 365].includes(input.retentionDays))
            throw Error('学習設定が無効です');
        Object.assign(learningState(state), { enabled: input.enabled, disabledAccounts: [...new Set(input.disabledAccounts)], keywords: [...new Set(input.keywords.map((s) => s.trim()).filter(Boolean))], retentionDays: input.retentionDays });
        pruneLearning(state);
        return { ok: true };
    }
    if (path === '/api/learning-proposal') {
        if (!['accept', 'later', 'never', 'priority'].includes(input.action))
            throw Error('提案の操作が無効です');
        actOnProposal(state, String(input.id || ''), input.action);
        return { ok: true, remoteChanged: false };
    }
    if (path === '/api/learning-rule') {
        if (!['priority', 'quiet', null].includes(input.mode))
            throw Error('通知の設定が無効です');
        setLocalRule(state, input.accountId, input.threadId, input.mode);
        return { ok: true, remoteChanged: false };
    }
    if (path === '/api/learning-undo') {
        undoLocalRule(state, String(input.id || ''));
        return { ok: true, remoteChanged: false };
    }
    if (path === '/api/learning-clear') {
        if (input.confirm !== true)
            throw Error('履歴の消去を確認してください');
        const old = learningState(state);
        state.learning = { ...old, events: [], proposals: [], changes: [], suppressed: [], excluded: 0 };
        return { ok: true, rulesKept: true };
    }
    return undefined;
}
export { learningSummary };
