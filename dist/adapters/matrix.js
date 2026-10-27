/** Matrix endpoint for a separately managed Messenger bridge; never reads installed Sendy credentials. */
export class MatrixAdapter {
    async call(a, path, init = {}) { const base = new URL(a.config.homeserver); if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))
        throw Error('MatrixはHTTPSまたはlocalhostだけに接続できます'); const response = await fetch(new URL(path, base), { ...init, redirect: 'error', headers: { Authorization: 'Bearer ' + a.config.token, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) }); if (!response.ok)
        throw Error('Matrixの認証またはブリッジ接続を確認してください'); return response.json(); }
    async sync(a) { const params = new URLSearchParams({ timeout: '0', filter: JSON.stringify({ room: { timeline: { limit: 50 } } }) }); if (a.config.since)
        params.set('since', a.config.since); const data = await this.call(a, '/_matrix/client/v3/sync?' + params); const batch = { threads: [], messages: [] }; for (const [id, room] of Object.entries(data.rooms?.join || {})) {
        const events = [...(room.state?.events || []), ...(room.timeline?.events || [])];
        const names = new Map(events.filter(e => e.type === 'm.room.member').map(e => [e.state_key, e.content?.displayname || e.state_key]));
        const rows = (room.timeline?.events || []).filter((e) => e.type === 'm.room.message').map((m) => ({ id: m.event_id, threadId: id, accountId: a.id, sender: names.get(m.sender) || m.sender, text: m.content?.body || '', ts: m.origin_server_ts || 0, isMe: m.sender === a.config.userId, attachments: m.content?.msgtype === 'm.text' ? [] : [{ name: m.content?.body || 'attachment', kind: m.content?.msgtype || 'file' }], replyTo: m.content?.['m.relates_to']?.['m.in_reply_to']?.event_id }));
        batch.messages.push(...rows);
        batch.threads.push({ id, accountId: a.id, title: events.find(e => e.type === 'm.room.name')?.content?.name || room.summary?.['m.heroes']?.map((id) => names.get(id) || id).join('、') || id, isGroup: names.size > 2, updatedAt: Math.max(0, ...rows.map((m) => m.ts)), members: [...names.values()], membersComplete: false });
    } if (data.next_batch)
        a.config.since = data.next_batch; return batch; }
    async sendText(a, t, text, id) { const result = await this.call(a, `/_matrix/client/v3/rooms/${encodeURIComponent(t.id)}/send/m.room.message/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ msgtype: 'm.text', body: text }) }); return { id: String(result.event_id) }; }
}
