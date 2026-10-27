import { slackMessage } from '../slack-message.js';
import { downloadPrivateAttachment } from '../attachment-download.js';
export class SlackAdapter {
    endpoint;
    features = { files: true, quote: true, edit: true, delete: true, reactions: true, members: true, receipts: true };
    retryAt = new Map();
    profiles = new Map();
    constructor(endpoint = 'https://slack.com/api/') {
        this.endpoint = endpoint;
    }
    async call(a, method, args = {}) {
        if (Math.max(this.retryAt.get(a.id) || 0, Number(a.config.slackRetryAt) || 0) > Date.now())
            throw Error('Slack rate_limited');
        const url = new URL(method, this.endpoint);
        for (const [k, v] of Object.entries(args))
            url.searchParams.set(k, v);
        const res = await fetch(url, { headers: { Authorization: `Bearer ${a.config.token}`, ...(a.config.cookie ? { Cookie: a.config.cookie } : {}) }, signal: AbortSignal.timeout(20000), redirect: 'error' });
        if (res.status === 429) {
            const delay = Number(res.headers.get('Retry-After')), retry = Date.now() + Math.max(60, Math.min(86400, Number.isFinite(delay) ? delay : 60)) * 1000;
            this.retryAt.set(a.id, retry);
            a.config.slackRetryAt = String(retry);
            throw Error('Slack rate_limited');
        }
        if (!res.ok)
            throw Error('Slack HTTP error');
        const data = await res.json();
        if (!data.ok) {
            if (data.error === 'invalid_cursor')
                throw Error('Slack invalid_cursor');
            throw Error('Slack認証または権限が不足しています。接続設定を確認してください。');
        }
        return data;
    }
    async sync(a) {
        const auth = await this.call(a, 'auth.test');
        if ((a.config.viewerId && auth.user_id !== a.config.viewerId) || (a.config.teamId && auth.team_id !== a.config.teamId))
            throw Error('Slack identity_mismatch');
        const batch = { threads: [], messages: [] };
        // Fixed, bounded scan; no conversations.mark or write method is called.
        let cursor = '', nextCursor = '';
        const channels = [], seenChannels = new Set();
        const collect = (page) => { if (!Array.isArray(page.channels))
            throw Error('Slack history_unavailable'); for (const channel of page.channels)
            if (typeof channel.id === 'string' && !seenChannels.has(channel.id)) {
                seenChannels.add(channel.id);
                channels.push(channel);
            } };
        const first = await this.call(a, 'conversations.list', { types: 'im,mpim,public_channel,private_channel', exclude_archived: 'true', limit: '100' });
        collect(first);
        cursor = a.config.slackListCursor || first.response_metadata?.next_cursor || '';
        for (let page = 0; page < 2 && cursor; page++) {
            try {
                const response = await this.call(a, 'conversations.list', { types: 'im,mpim,public_channel,private_channel', exclude_archived: 'true', limit: '100', cursor });
                collect(response);
                nextCursor = response.response_metadata?.next_cursor || '';
                if (nextCursor === cursor)
                    throw Error('Slack history_unavailable');
                cursor = nextCursor;
            }
            catch (error) {
                if (error instanceof Error && error.message === 'Slack invalid_cursor')
                    cursor = first.response_metadata?.next_cursor || '';
                batch.warning = '会話一覧の追加取得は次回の同期で再開します';
                batch.warningCode = 'partial_fetch';
                break;
            }
        }
        a.config.slackListCursor = cursor;
        if (cursor) {
            batch.warning = batch.warning || '会話一覧を保存した位置から順に追加取得しています';
            batch.warningCode = 'partial_fetch';
        }
        let failed = 0, nameBudget = 12;
        const displayName = async (id) => {
            if (id === auth.user_id)
                return '自分';
            const key = a.id + ':' + id, cached = this.profiles.get(key);
            if (cached && Date.now() - cached.at < 3600000)
                return cached.name;
            if (!/^[UW][A-Z0-9]+$/.test(id) || nameBudget <= 0)
                return id;
            nameBudget--;
            try {
                const result = await this.call(a, 'users.info', { user: id }), user = result.user;
                if (user?.id !== id)
                    return id;
                const name = String(user.profile?.display_name || user.real_name || user.name || id).slice(0, 200);
                this.profiles.set(key, { name, at: Date.now() });
                return name;
            }
            catch {
                return id;
            }
        };
        for (const c of channels) {
            if (c.is_member === false && !c.is_im && !c.is_mpim)
                continue;
            let data;
            try {
                data = await this.call(a, 'conversations.history', { channel: c.id, limit: '50' });
            }
            catch {
                failed++;
                if ((this.retryAt.get(a.id) || 0) > Date.now())
                    break;
                continue;
            }
            let detail = c;
            try {
                const info = await this.call(a, 'conversations.info', { channel: c.id });
                if (info.channel?.id === c.id)
                    detail = { ...c, ...info.channel };
            }
            catch { }
            const title = detail.name || (detail.user ? await displayName(detail.user) : detail.id);
            const messages = [];
            for (const m of data.messages || [])
                messages.push(slackMessage(a, c.id, m, auth.user_id, m.user ? await displayName(m.user) : m.username));
            batch.messages.push(...messages);
            batch.threads.push({ id: c.id, accountId: a.id, title, sourceUnread: Number.isFinite(detail.unread_count_display) ? detail.unread_count_display > 0 : typeof detail.last_read === 'string' ? messages.some((m) => !m.isMe && Number(m.id) > Number(detail.last_read)) : undefined, sourceUnreadCount: Number.isFinite(detail.unread_count_display) ? detail.unread_count_display : undefined, isGroup: !detail.is_im, updatedAt: Math.max(0, ...messages.map((m) => m.ts)), members: [...new Set(messages.map((m) => m.sender))], membersComplete: false });
        }
        if (failed) {
            if (!batch.threads.length)
                throw Error((this.retryAt.get(a.id) || 0) > Date.now() ? 'Slack rate_limited' : 'Slack history_unavailable');
            batch.warning = '取得できた会話を表示しています。一部の会話は権限または取得制限により未取得です。';
            batch.warningCode = 'partial_fetch';
        }
        return batch;
    }
    async identity(a) { const identity = await this.call(a, 'auth.test'); if (a.config.viewerId && identity.user_id !== a.config.viewerId || a.config.teamId && identity.team_id !== a.config.teamId)
        throw Error('Slack identity_mismatch'); return String(identity.user_id); }
    async write(a, method, body) { const r = await fetch(new URL(method, this.endpoint), { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + a.config.token, 'Content-Type': 'application/json', ...(a.config.cookie ? { Cookie: a.config.cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); const data = await r.json(); if (!r.ok || !data.ok)
        throw Error('Slackの操作結果を確認できません'); return data; }
    async sendText(a, t, text, id) { return this.sendContent(a, t, { text, files: [] }, id); }
    async markRead(a, t, message) { await this.identity(a); if (!/^\d+\.\d+$/.test(message.id))
        throw Error('既読の位置が無効です'); await this.write(a, 'conversations.mark', { channel: t.id, ts: message.id }); }
    async sendContent(a, t, content, id) {
        await this.identity(a);
        if (content.files.length) {
            const files = [];
            for (const file of content.files) {
                const upload = await this.call(a, 'files.getUploadURLExternal', { filename: file.name, length: String(file.data.length) }), url = new URL(upload.upload_url);
                if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.username || url.password)
                    throw Error('Slackの添付送信先が無効です');
                const response = await fetch(url, { method: 'POST', body: new Uint8Array(file.data), headers: { 'Content-Type': 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(120000) });
                if (!response.ok)
                    throw Error('Slackの添付アップロード結果を確認できません');
                files.push({ id: String(upload.file_id), title: file.name });
            }
            const result = await this.write(a, 'files.completeUploadExternal', { files, channel_id: t.id, initial_comment: content.text, ...(content.replyTo ? { thread_ts: content.replyTo } : {}) });
            return { id: String(result.files?.[0]?.id || id) };
        }
        const result = await this.write(a, 'chat.postMessage', { channel: t.id, text: content.text, client_msg_id: id, unfurl_links: false, unfurl_media: false, ...(content.replyTo ? { thread_ts: content.replyTo } : {}) });
        return { id: String(result.ts) };
    }
    async downloadAttachment(a, file) { return downloadPrivateAttachment(a, file, ['slack.com', 'slack-files.com', 'slack-edge.com'], ['slack.com']); }
    async loadThread(a, t, before) { const viewer = await this.identity(a); if (before && !/^\d+\.\d+$/.test(before))
        throw Error('履歴位置が無効です'); const data = await this.call(a, 'conversations.history', { channel: t.id, limit: '100', ...(before ? { latest: before, inclusive: 'false' } : {}) }); return { threads: [], messages: (data.messages || []).map((m) => slackMessage(a, t.id, m, viewer, this.profiles.get(a.id + ':' + m.user)?.name)) }; }
    async loadReplies(a, t, message) {
        const viewer = await this.identity(a), root = message.replyTo || message.id, saved = t.replyPages?.[root], rows = [];
        let cursor = saved?.cursor || '', newest = saved?.newest || saved?.oldest || root, warning = '', restart = false;
        for (let page = 0; page < 10; page++) {
            try {
                const data = await this.call(a, 'conversations.replies', { channel: t.id, ts: root, limit: '100', cursor, ...(saved?.oldest ? { oldest: saved.oldest, inclusive: 'false' } : {}) });
                if (!Array.isArray(data.messages))
                    throw Error('Slack history_unavailable');
                rows.push(...data.messages);
                for (const row of data.messages)
                    if (Number(row.ts) > Number(newest))
                        newest = row.ts;
                const next = data.response_metadata?.next_cursor || '';
                if (next && next === cursor)
                    throw Error('Slack history_unavailable');
                cursor = next;
                if (!cursor)
                    break;
            }
            catch (error) {
                if (error instanceof Error && error.message === 'Slack invalid_cursor') {
                    restart = true;
                    warning = 'Slackの続きの位置が失効したため、次回は保存済みの日時から取り直します。重複は除去します';
                    break;
                }
                if (!rows.length)
                    throw error;
                warning = '返信スレッドの追加取得を中断しました。保存した位置から再開できます';
                break;
            }
        }
        (t.replyPages ??= {})[root] = restart ? { cursor: '', oldest: saved?.oldest, newest: saved?.newest } : cursor ? { cursor, oldest: saved?.oldest, newest } : { cursor: '', oldest: newest, newest };
        return { threads: [], messages: rows.map(m => slackMessage(a, t.id, m, viewer, this.profiles.get(a.id + ':' + m.user)?.name)), ...(cursor || warning ? { warning: warning || '返信を1000件追加しました。再度スレッド取得を押すと続きから再開します', warningCode: 'partial_fetch' } : {}) };
    }
    async loadMembers(a, t) { await this.identity(a); const members = []; let cursor = ''; do {
        const data = await this.call(a, 'conversations.members', { channel: t.id, limit: '200', cursor });
        members.push(...(data.members || []));
        cursor = data.response_metadata?.next_cursor || '';
        if (members.length >= 10000 && cursor)
            throw Error('参加者が多いため完全な名簿を取得できませんでした');
    } while (cursor); return [...new Set(members)].map(id => ({ id, name: this.profiles.get(a.id + ':' + id)?.name || id })); }
    async performAction(a, t, action) {
        const viewer = await this.identity(a), reply = action.threadRoot && action.threadRoot !== action.messageId;
        const found = await this.call(a, reply ? 'conversations.replies' : 'conversations.history', { channel: t.id, ...(reply ? { ts: action.threadRoot } : {}), oldest: action.messageId, latest: action.messageId, inclusive: 'true', limit: '1' }), message = (found.messages || []).find((m) => String(m.ts) === action.messageId);
        if (!message || String(message.text || '') !== action.expectedText)
            throw Error('対象のメッセージが更新または削除されました');
        if ((action.kind === 'edit' || action.kind === 'delete') && message.user !== viewer)
            throw Error('自分のメッセージだけを変更できます');
        if (action.kind === 'edit') {
            await this.write(a, 'chat.update', { channel: t.id, ts: action.messageId, text: action.text });
            return;
        }
        if (action.kind === 'delete') {
            await this.write(a, 'chat.delete', { channel: t.id, ts: action.messageId });
            return;
        }
        if (!/^[a-zA-Z0-9_+-]{1,100}$/.test(action.emoji || ''))
            throw Error('Slackの絵文字名を指定してください');
        await this.write(a, action.kind === 'react-add' ? 'reactions.add' : 'reactions.remove', { channel: t.id, timestamp: action.messageId, name: action.emoji });
    }
}
