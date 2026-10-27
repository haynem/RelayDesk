export function lineDisplayName(raw) { const name = raw?.targetProfileDetail?.profileName || raw?.contact?.displayName || raw?.displayName; return typeof name === 'string' && name.trim() ? name : undefined; }
export async function lookupLineName(client, id, preferred = 'v3') {
    const methods = [preferred, ...['v3', 'v2', 'legacy'].filter(m => m !== preferred)];
    for (const method of methods)
        try {
            const raw = method === 'v3' ? (await client.getUser(id)).raw : method === 'v2' ? (await client.base.talk.getContactsV2({ mids: [id] })).contacts?.[id] : await client.base.talk.getContact({ mid: id });
            const name = lineDisplayName(raw);
            if (name)
                return { name, method };
        }
        catch { }
    return { name: id, method: undefined };
}
// A missing historical key must not discard other conversations or expose ciphertext.
export async function readLineMessage(raw, accountId, threadId, viewerId, decode) {
    const base = { id: String(raw.id), accountId, threadId, senderId: typeof raw.from === 'string' ? raw.from : undefined, sender: raw.from === viewerId ? '自分' : String(raw.from || '不明'), isMe: raw.from === viewerId, ts: Number(raw.createdTime) || 0, historyCursor: String(raw.createdTime || 0) + ':' + String(raw.id), attachments: [] };
    try {
        const message = await decode(raw);
        const content = message.raw;
        return { ...base, replyTo: content.relatedMessageId ? String(content.relatedMessageId) : undefined, text: message.text || '', attachments: content.contentType !== 0 && content.contentType !== 'NONE' ? [{ name: String(content.contentMetadata?.FILE_NAME || content.contentMetadata?.STKTXT || 'LINE添付'), kind: { 1: 'image/jpeg', 2: 'video/mp4', 3: 'audio/mp4', 14: 'application/octet-stream', 7: 'image/png', IMAGE: 'image/jpeg', VIDEO: 'video/mp4', AUDIO: 'audio/mp4', STICKER: 'image/png', FILE: 'application/octet-stream' }[String(content.contentType)] || 'application/octet-stream', remoteId: JSON.stringify({ messageId: base.id, threadId, ts: base.ts, sticker: content.contentMetadata?.STKID }) }] : [] };
    }
    catch {
        return { ...base, text: 'このメッセージは暗号化を解除できませんでした。元のLINEで確認してください。', unavailable: true };
    }
}
