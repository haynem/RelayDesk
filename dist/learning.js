import { randomUUID } from 'node:crypto';
import { sensitive } from './notifications.js';
const composite = (accountId, threadId) => JSON.stringify([accountId, threadId]);
export function learningState(state) {
    return state.learning ??= ({ enabled: true, disabledAccounts: [], keywords: [], retentionDays: 90, events: [], rules: [], proposals: [], changes: [], suppressed: [], excluded: 0 });
}
export function pruneLearning(state, now = Date.now()) {
    const learning = state.learning;
    if (!learning)
        return;
    const cutoff = now - Math.max(7, Math.min(365, learning.retentionDays)) * 86400000;
    const valid = new Set(state.accounts.map(a => a.id));
    learning.events = learning.events.filter(e => e.at >= cutoff && valid.has(e.accountId)).slice(-20000);
    learning.proposals = learning.proposals.filter(p => valid.has(p.accountId) && (p.status === 'pending' || p.createdAt >= cutoff)).slice(-1000);
    learning.rules = learning.rules.filter(r => valid.has(r.accountId));
    learning.changes = learning.changes.filter(c => valid.has(c.accountId) && c.at >= cutoff).slice(-1000);
    learning.disabledAccounts = learning.disabledAccounts.filter(id => valid.has(id));
    if (learning.ruleVersions)
        for (const k of Object.keys(learning.ruleVersions))
            try {
                if (!valid.has(JSON.parse(k)[0]))
                    delete learning.ruleVersions[k];
            }
            catch {
                delete learning.ruleVersions[k];
            }
    learning.suppressed = learning.suppressed.filter(s => { try {
        return valid.has(JSON.parse(s.slice(0, s.lastIndexOf(':')))[0]);
    }
    catch {
        return false;
    } });
}
export function observeLearning(state, kind, message, now = Date.now()) {
    const learning = learningState(state);
    if (!learning.enabled || !message || message.isMe || message.deleted || message.unavailable || learning.disabledAccounts.includes(message.accountId))
        return false;
    if (sensitive(message.text)) {
        if (kind === 'received')
            learning.excluded++;
        return false;
    }
    if (!state.threads.some(t => t.accountId === message.accountId && t.id === message.threadId))
        return false;
    if (learning.events.some(e => e.accountId === message.accountId && e.threadId === message.threadId && e.messageId === message.id && e.kind === kind))
        return false;
    const received = learning.events.find(e => e.accountId === message.accountId && e.threadId === message.threadId && e.messageId === message.id && e.kind === 'received');
    // Action observations without a locally observed arrival are retained as actions, not invented notification reactions.
    learning.events.push({ id: randomUUID(), accountId: message.accountId, threadId: message.threadId, messageId: message.id, kind, at: now, ...(received && now >= received.at ? { latencyMs: now - received.at } : {}) });
    pruneLearning(state, now);
    return true;
}
export function observations(state, accountId, threadId, now = Date.now()) {
    const events = (state.learning?.events || []).filter(e => e.accountId === accountId && e.threadId === threadId), received = events.filter(e => e.kind === 'received'), ids = new Set(received.map(e => e.messageId));
    const opens = events.filter(e => e.kind === 'opened' && ids.has(e.messageId)), replies = events.filter(e => e.kind === 'replied' && ids.has(e.messageId)), dismissed = events.filter(e => e.kind === 'dismissed' && ids.has(e.messageId)), latencies = opens.flatMap(e => e.latencyMs === undefined ? [] : [e.latencyMs]);
    return { count: received.length, opened: opens.length, replied: replies.length, dismissed: dismissed.length, days: received.length ? Math.max(0, (now - Math.min(...received.map(e => e.at))) / 86400000) : 0, ...(latencies.length ? { meanOpenMs: latencies.reduce((a, b) => a + b, 0) / latencies.length } : {}) };
}
export function localRule(state, accountId, threadId) { return state.learning?.rules.find(r => r.accountId === accountId && r.threadId === threadId); }
export function learningAdjustment(state, thread, message, now = Date.now()) {
    const learning = state.learning, rule = localRule(state, thread.accountId, thread.id), reasons = [];
    let delta = 0, forceHigh = rule?.mode === 'priority';
    if (forceHigh)
        reasons.push('あなたが常に優先する会話に指定');
    if (!learning?.enabled || learning.disabledAccounts.includes(thread.accountId) || message.unavailable || sensitive(message.text))
        return { delta, forceHigh, reasons };
    if (learning.keywords.some(k => k && message.text.toLowerCase().includes(k.toLowerCase()))) {
        forceHigh = true;
        reasons.push('指定した重要キーワード');
    }
    const o = observations(state, thread.accountId, thread.id, now);
    if (o.count >= 20 && o.days >= 7) {
        if (o.opened / o.count >= .5) {
            delta += 10;
            reasons.push('このアプリでよく確認する会話');
        }
        if (o.replied > 0) {
            delta += 10;
            reasons.push('このアプリからの返信実績');
        }
        if (o.opened >= 5 && o.meanOpenMs !== undefined && o.meanOpenMs < 120000) {
            delta += 5;
            reasons.push('新着取得後に短時間で確認する傾向');
        }
        const bucket = Math.floor(new Date(now).getHours() / 6), arrivals = learning.events.filter(e => e.accountId === thread.accountId && e.threadId === thread.id && e.kind === 'received' && Math.floor(new Date(e.at).getHours() / 6) === bucket), ids = new Set(arrivals.map(e => e.messageId)), opens = learning.events.filter(e => e.accountId === thread.accountId && e.threadId === thread.id && e.kind === 'opened' && ids.has(e.messageId));
        if (arrivals.length >= 8 && opens.length / arrivals.length >= .6) {
            delta += 5;
            reasons.push('同じ時間帯によく確認する傾向（このアプリの実績）');
        }
        if (o.count / Math.max(1, o.days) > 30 && o.opened / o.count < .1 && o.replied === 0) {
            delta -= 15;
            reasons.push('新着が多く、このアプリでの確認・返信が少ない');
        }
    }
    return { delta, forceHigh, reasons };
}
export function refreshProposals(state, now = Date.now()) {
    const learning = learningState(state);
    pruneLearning(state, now);
    if (!learning.enabled)
        return;
    for (const thread of state.threads) {
        if (learning.disabledAccounts.includes(thread.accountId) || localRule(state, thread.accountId, thread.id))
            continue;
        const o = observations(state, thread.accountId, thread.id, now);
        if (o.count < 20 || o.days < 7)
            continue;
        let kind;
        const reasons = [];
        if (o.opened >= 5 && o.opened / o.count >= .6 && o.meanOpenMs !== undefined && o.meanOpenMs < 120000) {
            kind = 'priority';
            reasons.push('閲覧率60%以上', '平均2分以内に確認');
        }
        else if (o.count / o.days > 30 && o.opened / o.count < .1 && o.replied === 0 && o.dismissed / o.count > .5) {
            kind = 'quiet';
            reasons.push('1日平均30件超', '閲覧率10%未満・返信実績なし', 'このアプリで後回しにした割合50%超');
        }
        if (!kind || learning.suppressed.includes(composite(thread.accountId, thread.id) + ':' + kind))
            continue;
        const old = learning.proposals.find(p => p.accountId === thread.accountId && p.threadId === thread.id && p.kind === kind && (p.status === 'pending' || p.status === 'later'));
        const evidence = { received: o.count, opened: o.opened, dismissed: o.dismissed, replied: o.replied, days: o.days, meanOpenMs: o.meanOpenMs };
        if (old) {
            old.evidence = evidence;
            old.reasons = reasons;
            if (old.status === 'later' && (old.nextAt || 0) <= now)
                old.status = 'pending';
        }
        else
            learning.proposals.push({ id: randomUUID(), accountId: thread.accountId, threadId: thread.id, kind, createdAt: now, status: 'pending', evidence, reasons });
    }
}
export function setLocalRule(state, accountId, threadId, mode) {
    if (!state.threads.some(t => t.accountId === accountId && t.id === threadId))
        throw Error('会話がありません');
    const learning = learningState(state), previous = localRule(state, accountId, threadId);
    const versionKey = composite(accountId, threadId), versions = learning.ruleVersions ??= {}, previousVersion = versions[versionKey];
    learning.rules = learning.rules.filter(r => r.accountId !== accountId || r.threadId !== threadId);
    const id = randomUUID();
    if (mode)
        learning.rules.push({ id, accountId, threadId, mode, at: Date.now() });
    versions[versionKey] = id;
    learning.changes.push({ id: randomUUID(), accountId, threadId, at: Date.now(), ruleId: id, previous, previousVersion });
    return id;
}
export function actOnProposal(state, id, action) {
    const learning = learningState(state), proposal = learning.proposals.find(p => p.id === id && p.status === 'pending');
    if (!proposal)
        throw Error('有効な提案がありません');
    if (action === 'later') {
        proposal.status = 'later';
        proposal.nextAt = Date.now() + 7 * 86400000;
    }
    else if (action === 'never') {
        proposal.status = 'ignored';
        learning.suppressed.push(composite(proposal.accountId, proposal.threadId) + ':' + proposal.kind);
    }
    else {
        setLocalRule(state, proposal.accountId, proposal.threadId, action === 'priority' ? 'priority' : proposal.kind);
        proposal.status = 'accepted';
    }
}
export function undoLocalRule(state, id) {
    const learning = learningState(state), change = learning.changes.find(c => c.id === id && !c.undoneAt);
    if (!change)
        throw Error('取り消せる設定がありません');
    const versionKey = composite(change.accountId, change.threadId), versions = learning.ruleVersions ??= {};
    if (versions[versionKey] !== change.ruleId)
        throw Error('その後に変更された設定があります。現在の設定から変更してください');
    learning.rules = learning.rules.filter(r => r.accountId !== change.accountId || r.threadId !== change.threadId);
    if (change.previous)
        learning.rules.push(change.previous);
    change.undoneAt = Date.now();
    if (change.previousVersion)
        versions[versionKey] = change.previousVersion;
    else
        delete versions[versionKey];
}
export function learningSummary(state) {
    const learning = learningState(state);
    refreshProposals(state);
    return { ...learning, events: undefined, eventCount: learning.events.length, threads: state.threads.map(t => ({ accountId: t.accountId, threadId: t.id, ...observations(state, t.accountId, t.id) })).filter(t => t.count > 0) };
}
