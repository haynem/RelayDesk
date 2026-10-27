export function slackMessage(account, threadId, raw, viewerId, name) {
    return { id: String(raw.ts), accountId: account.id, threadId, sender: raw.user === viewerId ? '自分' : name || raw.user || raw.username || '不明', senderId: raw.user, text: String(raw.text || ''), ts: Math.round(Number(raw.ts) * 1000), isMe: raw.user === viewerId, replyTo: raw.thread_ts, editedAt: raw.edited?.ts ? Math.round(Number(raw.edited.ts) * 1000) : undefined,
        attachments: (raw.files || []).map((f) => ({ name: String(f.name || 'file'), kind: String(f.mimetype || 'application/octet-stream'), size: Number(f.size) || undefined, remoteId: String(f.id || ''), url: typeof f.url_private_download === 'string' ? f.url_private_download : typeof f.url_private === 'string' ? f.url_private : undefined })),
        reactions: (raw.reactions || []).map((r) => ({ name: String(r.name), count: Number(r.count) || 0, mine: Array.isArray(r.users) && r.users.includes(viewerId) })) };
}
