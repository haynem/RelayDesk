export const services = ['line', 'instagram', 'messenger', 'slack', 'email', 'discord'];
export const key = (...parts) => JSON.stringify(parts);
export function mergeBatch(state, account, batch) {
    const threads = new Map(state.threads.map(t => [key(t.accountId, t.id), t]));
    const messages = new Map(state.messages.map(m => [key(m.accountId, m.threadId, m.id), m]));
    for (const t of batch.threads) {
        if (t.accountId !== account.id)
            throw Error('Account mismatch');
        const old = threads.get(key(t.accountId, t.id));
        const newest = old && old.updatedAt > t.updatedAt ? old : t;
        threads.set(key(t.accountId, t.id), { ...t, title: newest.title, updatedAt: newest.updatedAt, lastSync: t.lastSync || old?.lastSync, replyAddress: newest.replyAddress, replyCc: newest.replyCc, mailReferences: newest.mailReferences, replyMessageId: newest.replyMessageId, sourceUnread: newest.sourceUnread, sourceUnreadCount: newest.sourceUnreadCount, members: old?.membersComplete ? old.members : [...new Set([...(old?.members || []), ...(t.members || [])])], membersComplete: old?.membersComplete || t.membersComplete, memberRecords: old?.membersComplete ? old.memberRecords : t.memberRecords || old?.memberRecords, remoteRef: t.remoteRef || old?.remoteRef, remoteJid: t.remoteJid || old?.remoteJid, remoteKey: t.remoteKey || old?.remoteKey, historyCursor: old?.historyCursor || t.historyCursor, historyComplete: old?.historyComplete ?? t.historyComplete, replyPages: old?.replyPages || t.replyPages, pinned: old?.pinned, folder: old?.folder, priority: old?.priority, priorityFeedback: old?.priorityFeedback, localSeenAt: old?.localSeenAt, localSeenMessageId: old?.localSeenMessageId, snoozedUntil: old?.snoozedUntil, composeMode: old?.composeMode });
    }
    for (const m of batch.messages) {
        if (m.accountId !== account.id)
            throw Error('Account mismatch');
        const k = key(m.accountId, m.threadId, m.id), old = messages.get(k);
        if (old?.deleted || old?.remoteTransport === 'e2ee' && m.remoteTransport === 'plain')
            continue;
        if (m.unavailable && old && !old.unavailable)
            continue;
        messages.set(k, { ...m, sender: m.sender === '不明' && old?.sender ? old.sender : m.sender, ...(old?.editedAt && (old.revision !== undefined && m.revision !== undefined ? old.revision > m.revision : old.editedAt > (m.editedAt || 0) && (m.editedAt !== undefined || Date.now() - old.editedAt < 30000)) ? { text: old.text, editedAt: old.editedAt, revision: old.revision } : {}), attachments: m.attachments.map((f, i) => { const prior = old?.attachments[i]; return !f.blobId && prior?.blobId && prior.name === f.name && prior.remoteId === f.remoteId ? { ...f, blobId: prior.blobId } : f; }) });
    }
    state.threads = [...threads.values()];
    state.messages = [...messages.values()];
    if (account.adapter === 'imap')
        for (const t of batch.threads) {
            const thread = threads.get(key(account.id, t.id)), rows = state.messages.filter(m => m.accountId === account.id && m.threadId === t.id);
            if (rows.length && rows.every(m => m.sourceUnread !== undefined)) {
                thread.sourceUnreadCount = rows.filter(m => m.sourceUnread).length;
                thread.sourceUnread = thread.sourceUnreadCount > 0;
            }
        }
}
