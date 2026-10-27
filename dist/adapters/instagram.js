export const IG_APP_ID = '936619743392459';
const millis = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : 0; };
const username = (u) => String(u?.full_name || u?.username || u?.pk || '不明');
function mapThread(raw, a, viewer) {
    const id = String(raw.thread_id);
    const users = new Map((raw.users || []).map((u) => [String(u.pk || u.pk_id || u.id), u]));
    const messages = (raw.items || []).filter((m) => m.item_id || m.message_id).map((m) => {
        const senderId = String(m.user_id || '');
        let text = String(m.text || '');
        const attachments = [];
        if (m.item_type === 'link')
            text = m.link?.text || m.link?.link_context?.link_url || text;
        if (m.item_type === 'media') {
            const kind = m.media?.video_versions?.length ? 'video' : 'image';
            attachments.push({ name: kind === 'video' ? '動画' : '画像', kind });
            text = m.media?.caption || text;
        }
        if (m.item_type === 'action_log')
            text = m.action_log?.description || 'システム通知';
        if (m.item_type === 'placeholder')
            text = m.placeholder?.message || m.placeholder?.title || 'この形式は取得できません';
        if (!text && !attachments.length)
            text = `（${String(m.item_type || '未対応のメッセージ')}）`;
        return { id: String(m.item_id || m.message_id), threadId: id, accountId: a.id, sender: senderId === viewer ? '自分' : users.has(senderId) ? username(users.get(senderId)) : '不明', text, ts: millis(m.timestamp), isMe: senderId === viewer || m.is_sent_by_viewer === true, attachments, replyTo: m.replied_to_message?.item_id ? String(m.replied_to_message.item_id) : undefined };
    });
    const peers = [...users.entries()].filter(([id]) => id !== viewer).map(([, u]) => username(u));
    return { thread: { id, accountId: a.id, title: String(raw.thread_title || peers.join('、') || 'Instagramの会話'), isGroup: raw.is_group === true || peers.length > 1, updatedAt: millis(raw.last_activity_at) || Math.max(0, ...messages.map(m => m.ts)), members: peers, membersComplete: false }, messages };
}
export class InstagramAdapter {
    read;
    constructor(read) {
        this.read = read;
    }
    async sync(a) {
        const inbox = await this.read(a, '/api/v1/direct_v2/inbox/?persistentBadging=true&folder=0&limit=20&thread_message_limit=1');
        const viewer = String(inbox.viewer?.pk || '');
        if (!viewer || viewer !== a.config.viewerId)
            throw Error('Instagram identity_mismatch');
        const batch = { threads: [], messages: [] };
        for (const raw of (inbox.inbox?.threads || []).slice(0, 20)) {
            if (!raw.thread_id)
                continue;
            const detail = await this.read(a, `/api/v1/direct_v2/threads/${encodeURIComponent(String(raw.thread_id))}/?limit=30`);
            const mapped = mapThread(detail.thread || raw, a, viewer);
            batch.threads.push(mapped.thread);
            batch.messages.push(...mapped.messages);
        }
        return batch;
    }
}
