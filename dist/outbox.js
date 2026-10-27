import { createHash, randomBytes } from 'node:crypto';
import { sendReadReceipt } from './read-receipts.js';
import { observeLearning } from './learning.js';
export class Outbox {
    state;
    adapters;
    save;
    files;
    approvals = new Map();
    constructor(state, adapters, save, files) {
        this.state = state;
        this.adapters = adapters;
        this.save = save;
        this.files = files;
    }
    canSend(accountId) { const a = this.state.accounts.find(a => a.id === accountId), adapter = a ? this.adapters[a.adapter] : undefined; return !!a && !!(adapter?.sendText || adapter?.sendContent) && !(a.adapter === 'discord' && ['rpc', 'user'].includes(a.config?.mode)) && a.config?.authOnly !== 'true' && a.config?.coreReadOnly !== 'true' && (a.adapter !== 'imap' || !!a.config?.smtpHost); }
    target(id) {
        const d = this.state.drafts.find(d => d.id === id);
        if (!d || d.status !== 'pending')
            throw Error('送信可能な承認待ちの返信案がありません');
        const a = this.state.accounts.find(a => a.id === d.accountId), t = this.state.threads.find(t => t.accountId === d.accountId && t.id === d.threadId);
        if (!a || !t || !this.canSend(a.id) || this.adapters[a.adapter]?.canSendThread?.(a, t) === false)
            throw Error('この接続は送信に対応していません');
        const adapter = this.adapters[a.adapter];
        if (d.fileIds?.length && (!adapter.sendContent || adapter.features?.files !== true))
            throw Error('この接続の添付送信には対応していません');
        if (d.replyTo && (!adapter.sendContent || !adapter.features?.quote))
            throw Error('この接続の引用返信には対応していません');
        if (d.replyTo && !this.quote(d))
            throw Error('引用元が削除されています。返信案を作り直してください');
        if (!d.text.trim() && !d.fileIds?.length)
            throw Error('本文または添付が必要です');
        const assets = (d.fileIds || []).map(id => { const asset = this.state.assets?.find(a => a.id === id && a.accountId === d.accountId && a.draftId === d.id); if (!asset)
            throw Error('添付を確認してください'); return asset; });
        adapter.validateSend?.(a, t, { text: d.text, replyTo: d.replyTo, files: assets });
        return { d, a, t, adapter, assets };
    }
    quote(d) { return d.replyTo ? this.state.messages.find(m => m.accountId === d.accountId && m.threadId === d.threadId && (m.id === d.replyTo || m.mailMessageId === d.replyTo) && !m.deleted) : undefined; }
    digest(id) { const { d, a, t, assets } = this.target(id); return createHash('sha256').update(JSON.stringify([d.id, a.id, a.adapter, a.service, a.config?.user, a.config?.viewerId, a.config?.teamId, t.id, t.replyAddress, t.title, t.composeMode, t.replyMessageId, d.text, d.replyTo, d.emailCc, d.emailBcc, this.quote(d)?.text, this.quote(d)?.mailReferences, t.mailReferences, assets.map(f => [f.id, f.sha256, f.size, f.name, f.mime])])).digest('hex'); }
    prepare(id) { const { d, a, t, assets } = this.target(id); for (const [key, value] of this.approvals)
        if (value.expires < Date.now())
            this.approvals.delete(key); const challenge = randomBytes(32).toString('hex'); this.approvals.set(challenge, { draftId: id, digest: this.digest(id), expires: Date.now() + 5 * 60000 }); const quote = this.quote(d); return { challenge, preview: { service: a.service, account: a.name, recipient: t.replyAddress || t.title, subject: t.title, sender: a.service === 'email' ? a.config?.user : undefined, text: d.text, replyTo: d.replyTo, cc: d.emailCc, bcc: d.emailBcc, quote: quote ? { sender: quote.sender, text: quote.text } : undefined, files: assets.map(f => ({ name: f.name, size: f.size, mime: f.mime })) } }; }
    async approve(id, challenge, explicit) {
        const approval = this.approvals.get(challenge);
        this.approvals.delete(challenge);
        if (!explicit || !approval || approval.draftId !== id || approval.expires < Date.now() || approval.digest !== this.digest(id))
            throw Error('承認が無効か、内容が変わっています。もう一度確認してください');
        const { d, a, t, adapter } = this.target(id), files = d.fileIds?.length ? this.files?.(d) : [];
        if ((d.fileIds?.length || 0) !== (files?.length || 0))
            throw Error('添付を読み込めません。内容を確認してください');
        d.status = 'sending';
        this.save();
        let result;
        try {
            result = adapter.sendContent ? await adapter.sendContent(a, t, { text: d.text, replyTo: d.replyTo, cc: d.emailCc, bcc: d.emailBcc, references: a.adapter === 'imap' ? [...new Set([...(this.quote(d)?.mailReferences || t.mailReferences || []), ...(d.replyTo || t.replyMessageId ? [d.replyTo || t.replyMessageId] : [])])] : undefined, files: files || [] }, d.id) : await adapter.sendText(a, t, d.text, d.id);
        }
        catch (error) {
            if (error instanceof Error && error.definitelyNotSent === true) {
                d.status = 'pending';
                this.save();
                throw error;
            }
            d.status = 'uncertain';
            this.save();
            throw Error('送信結果を確定できません。自動再送せず、元サービスの送信履歴を確認してください');
        }
        d.status = 'sent';
        d.sentAt = Date.now();
        d.remoteId = result.id;
        const incoming = this.state.messages.filter(m => m.accountId === d.accountId && m.threadId === d.threadId && !m.isMe && !m.deleted).sort((a, b) => b.ts - a.ts)[0];
        observeLearning(this.state, 'replied', incoming);
        this.save();
        if (incoming) {
            try {
                const receipt = await sendReadReceipt(this.state, this.adapters, a, t, incoming, 'sent', this.save);
                d.receiptError = !!receipt.uncertain;
            }
            catch {
                d.receiptError = true;
            }
            this.save();
        }
        return { sent: true, receiptError: d.receiptError === true };
    }
}
