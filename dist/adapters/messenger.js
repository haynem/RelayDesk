import { absorbMessengerCookies } from '../auth-config.js';
import { MatrixAdapter } from './matrix.js';
import { downloadPrivateAttachment } from '../attachment-download.js';
import { randomUUID } from 'node:crypto';
import { readMessenger } from '../messenger-reader.js';
/** Browser authentication is stored independently; the local Matrix bridge attaches afterward. */
export class MessengerAdapter {
    helper;
    reader;
    encrypted;
    features = { files: true, quote: true, edit: true, delete: true, reactions: true, receipts: true, members: true };
    canSendThread(a, t) { return !t.remoteEncrypted || !!this.encrypted?.enabled(a.id) && !!t.remoteJid; }
    matrix = new MatrixAdapter();
    constructor(helper, reader = readMessenger, encrypted) {
        this.helper = helper;
        this.reader = reader;
        this.encrypted = encrypted;
    }
    async sync(a) {
        if (a.config.homeserver && a.config.token)
            return this.matrix.sync(a);
        if (!this.helper)
            throw Error('Messenger bridge_setup_required');
        if (this.encrypted?.enabled(a.id))
            await this.encrypted.ensure(a);
        const result = await this.reader(this.helper, { version: 1, mode: 'read', viewerId: a.config.viewerId, cookies: JSON.parse(a.config.cookies || '[]').map((c) => ({ name: c.name, value: c.value })) });
        if (result.viewerId !== a.config.viewerId)
            throw Error('Messenger identity_mismatch');
        absorbMessengerCookies(a, result.cookies);
        if (!Array.isArray(result.threads) || !Array.isArray(result.messages))
            throw Error('Messenger invalid_response');
        const batch = { threads: result.threads.map((t) => ({ id: String(t.id), accountId: a.id, title: String(t.title || 'Messengerの会話'), isGroup: !!t.isGroup, updatedAt: Number(t.updatedAt) || 0, members: [], membersComplete: false, remoteEncrypted: !!t.encrypted, remoteJid: t.remoteJid, remoteRef: t.sourceId, bodyUnavailable: !!t.encrypted && !result.messages.some((m) => String(m.threadId) === String(t.id)), sourceUnread: typeof t.sourceUnread === 'boolean' ? t.sourceUnread : undefined })), messages: result.messages.map((m) => this.mapMessage(a, m)) };
        const ids = new Set(batch.threads.map(t => t.id));
        if (batch.messages.some(m => !ids.has(m.threadId)))
            throw Error('Messenger thread_mismatch');
        a.config.authOnly = 'false';
        a.config.coreReadOnly = 'false';
        for (const thread of batch.threads)
            thread.members = [...new Set(batch.messages.filter(m => m.threadId === thread.id).map(m => m.sender))];
        if (result.encryptedWithoutBody > 0 && !this.encrypted?.enabled(a.id))
            batch.warning = 'Messengerの初期一覧を取得しましたが、' + Number(result.encryptedWithoutBody) + '会話の暗号化された本文は未取得です。元のサービス画面で確認してください。';
        return batch;
    }
    async sendText(a, t, text, id) { if (!a.config.homeserver || !a.config.token)
        throw Error('Messenger bridge_setup_required'); return this.matrix.sendText(a, t, text, id); }
    async operation(a, t, mode, options = {}, legacy = false) {
        if (!this.helper || t.remoteEncrypted && !(legacy && t.remoteRef && ['edit', 'delete', 'react-add', 'react-remove', 'receipt'].includes(mode)))
            throw Error('暗号化された会話には専用の連携設定が必要です。元のMessenger画面から操作してください');
        const result = await this.reader(this.helper, { version: 1, mode, viewerId: a.config.viewerId, threadId: legacy ? t.remoteRef : t.id, cookies: JSON.parse(a.config.cookies || '[]').map((c) => ({ name: c.name, value: c.value })), ...options });
        if (result.viewerId !== a.config.viewerId)
            throw Error('Messenger identity_mismatch');
        return result;
    }
    async sendContent(a, t, content, id) {
        if (t.remoteEncrypted && this.encrypted)
            return this.encrypted.send(a, t, content, id);
        if (a.config.homeserver && a.config.token) {
            if (content.files.length || content.replyTo)
                throw Error('このブリッジの添付・引用は元サービスで操作してください');
            return this.matrix.sendText(a, t, content.text, id);
        }
        const result = await this.operation(a, t, 'send', { approved: true, operationId: id, text: content.text, replyTo: content.replyTo, files: content.files.map(f => ({ name: f.name, mime: f.mime, data: f.data.toString('base64') })) });
        if (!result.confirmed || !result.remoteId)
            throw Error('Messenger send_result_unknown');
        return { id: String(result.remoteId) };
    }
    async performAction(a, t, action, id) { if (t.remoteEncrypted && this.encrypted && action.remoteTransport !== 'plain')
        return this.encrypted.action(a, t, action, id); if (a.config.homeserver)
        throw Error('ブリッジのメッセージ操作は元サービスで行ってください'); const result = await this.operation(a, t, action.kind, { approved: true, operationId: id, messageId: action.messageId, timestamp: action.messageTimestamp, expectedText: action.expectedText, text: action.text, emoji: action.emoji }, action.remoteTransport === 'plain'); if (!result.confirmed)
        throw Error('Messenger action_result_unknown'); }
    async markRead(a, t, message) { if (t.remoteEncrypted && this.encrypted && message.remoteTransport !== 'plain')
        return this.encrypted.receipt(a, t, message); if (a.config.homeserver)
        throw Error('このブリッジでは既読更新を利用できません'); const result = await this.operation(a, t, 'receipt', { approved: true, operationId: randomUUID(), messageId: message.id, timestamp: message.ts }, message.remoteTransport === 'plain'); if (!result.confirmed)
        throw Error('Messenger receipt_result_unknown'); }
    async loadThread(a, t, before) { if (t.remoteEncrypted && this.encrypted)
        return this.encrypted.history(a, t, before); const split = before?.indexOf(':') ?? -1; if (!before || split < 1)
        throw Error('履歴の先頭を指定してください'); const result = await this.operation(a, t, 'history', { timestamp: Number(before.slice(0, split)), messageId: before.slice(split + 1) }); return { threads: [], messages: (result.messages || []).map((m) => this.mapMessage(a, m)) }; }
    mapMessage(a, m) { return { id: String(m.id), threadId: String(m.threadId), accountId: a.id, sender: String(m.sender || '不明'), text: String(m.text || ''), unavailable: !!m.unavailable, remoteJid: m.remoteJid, remoteTransport: 'plain', ts: Number(m.ts) || 0, historyCursor: String(Number(m.ts) || 0) + ':' + String(m.id), isMe: !!m.isMe, deleted: !!m.deleted, revision: Number(m.revision) || 0, editedAt: Number(m.revision) > 0 ? Number(m.ts) || undefined : undefined, attachments: (m.attachments || []).map((f) => ({ name: String(f.name || '添付'), kind: String(f.kind || 'application/octet-stream'), url: typeof f.url === 'string' ? f.url : undefined, size: Number(f.size) || undefined })), replyTo: typeof m.replyTo === 'string' ? m.replyTo : undefined }; }
    async loadMembers(a, t) { if (t.remoteEncrypted && this.encrypted)
        return this.encrypted.members(a, t); throw Error('この平文会話の名簿は元サービスで確認してください'); }
    async downloadAttachment(a, file) { if (file.remoteId?.startsWith('e2ee:') && this.encrypted)
        return this.encrypted.download(a, file); return downloadPrivateAttachment(a, file, ['fbcdn.net', 'facebook.com', 'fbsbx.com'], []); }
}
