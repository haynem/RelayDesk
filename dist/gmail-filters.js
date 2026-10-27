import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mailAccessToken } from './mail-oauth.js';
const scope = 'https://www.googleapis.com/auth/gmail.settings.basic';
const payload = (sender) => ({ criteria: { from: sender }, action: { removeLabelIds: ['INBOX'] } });
const fingerprint = (value) => JSON.stringify({ criteria: value?.criteria || {}, action: value?.action || {} });
class PreflightError extends Error {
    definitelyNotSent = true;
}
export class GmailFilters {
    state;
    save;
    approvals = new Map();
    busy = new Set();
    constructor(state, save) {
        this.state = state;
        this.save = save;
        for (const row of state.gmailFilters || [])
            if (row.status === 'running')
                row.status = 'uncertain';
    }
    inFlight(id) { return this.busy.has(id); }
    supported(account) { return account.adapter === 'imap' && account.config.oauthProvider === 'google' && (account.config.oauthScopes || '').split(' ').includes(scope); }
    account(id) { const account = this.state.accounts.find(a => a.id === id); if (!account || !this.supported(account))
        throw new PreflightError('Gmailの公式OAuth接続でフィルター設定権限を許可してください。アプリパスワードでは設定できません'); return account; }
    rows(id) { return (this.state.gmailFilters || []).filter(row => row.accountId === id).map(({ beforeIds, ...row }) => row); }
    stage(input) {
        this.account(input.accountId);
        let row;
        if (input.sourceId) {
            const source = this.state.gmailFilters?.find(r => r.id === input.sourceId && r.accountId === input.accountId && r.kind === 'create' && r.status === 'done' && r.remoteId && !r.removedAt);
            if (!source)
                throw new PreflightError('このアプリで作成した有効なフィルターがありません');
            row = { id: randomUUID(), accountId: input.accountId, sender: source.sender, kind: 'remove', status: 'pending', createdAt: Date.now(), remoteId: source.remoteId, sourceId: source.id };
        }
        else {
            const sender = input.sender?.trim().toLowerCase();
            if (!sender || sender.length > 254 || !/^[a-z0-9.!#$%&'*+\-\/=?^_`{|}~]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(sender))
                throw new PreflightError('送信元のメールアドレスを1つ入力してください');
            row = { id: randomUUID(), accountId: input.accountId, sender, kind: 'create', status: 'pending', createdAt: Date.now() };
        }
        (this.state.gmailFilters ??= []).push(row);
        this.save();
        return { id: row.id };
    }
    target(id) { const row = this.state.gmailFilters?.find(r => r.id === id && r.status === 'pending'); if (!row)
        throw new PreflightError('承認待ちのGmail設定がありません'); return { row, account: this.account(row.accountId) }; }
    digest(id) { const { row, account } = this.target(id); return createHash('sha256').update(JSON.stringify([row, account.id, account.config.user, account.config.viewerId, account.config.oauthClientId])).digest('hex'); }
    prepare(id) { const { row, account } = this.target(id), challenge = randomBytes(32).toString('hex'); this.approvals.set(challenge, { id, digest: this.digest(id), expires: Date.now() + 300000 }); return { challenge, preview: { account: account.name, sender: row.sender, kind: row.kind, description: row.kind === 'create' ? '今後この送信元から届くメールをGmailの受信トレイから自動的に除外します。既存メールの移動・削除・迷惑メール報告・ブロックは行いません。' : 'このアプリで作成した自動除外フィルターを削除します。既に受信トレイから外れたメールは移動しません。' } }; }
    async request(account, path, options = {}) {
        const access = await mailAccessToken(account);
        this.save();
        const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/filters' + path, { ...options, redirect: 'error', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) });
        if (response.status === 404)
            return undefined;
        if (!response.ok)
            throw Error('Gmailの設定権限・APIの有効化・利用制限を確認してください');
        return response.status === 204 ? {} : response.json();
    }
    same(remote, sender) { return fingerprint(remote) === fingerprint(payload(sender)); }
    async approve(id, challenge, explicit) {
        const approval = this.approvals.get(challenge);
        this.approvals.delete(challenge);
        if (!explicit || !approval || approval.id !== id || approval.expires < Date.now() || approval.digest !== this.digest(id))
            throw new PreflightError('承認内容が変わったか有効期限が切れています');
        const { row, account } = this.target(id);
        if (this.busy.has(account.id))
            throw new PreflightError('このGmail設定を操作中です');
        this.busy.add(account.id);
        let attempted = false;
        try {
            if (row.kind === 'create') {
                const listed = await this.request(account, '');
                const filters = listed?.filter || [];
                if (!Array.isArray(filters))
                    throw new PreflightError('Gmailのフィルター一覧を確認できません');
                if (filters.some((f) => this.same(f, row.sender)))
                    throw new PreflightError('同じ内容のフィルターが既にあります。重複作成せず、既存設定は変更しません');
                row.beforeIds = filters.map((f) => String(f.id));
                row.status = 'running';
                this.save();
                attempted = true;
                const result = await this.request(account, '', { method: 'POST', body: JSON.stringify(payload(row.sender)) });
                if (!result?.id || !this.same(result, row.sender))
                    throw Error('結果不明');
                row.remoteId = String(result.id);
            }
            else {
                const remote = await this.request(account, '/' + encodeURIComponent(row.remoteId));
                if (remote && !this.same(remote, row.sender))
                    throw new PreflightError('Gmail上の設定が変更されています。別の設定を削除しないため操作を止めました');
                row.status = 'running';
                this.save();
                if (remote) {
                    attempted = true;
                    await this.request(account, '/' + encodeURIComponent(row.remoteId), { method: 'DELETE' });
                }
                const source = this.state.gmailFilters?.find(r => r.id === row.sourceId);
                if (source)
                    source.removedAt = Date.now();
            }
            row.status = 'done';
            row.finishedAt = Date.now();
            delete row.beforeIds;
            this.save();
            return { executed: true };
        }
        catch (error) {
            row.status = attempted ? 'uncertain' : 'pending';
            this.save();
            throw new Error(attempted ? 'Gmailの設定変更の結果が不明です。自動で繰り返しません。「結果を再確認」から読み取りだけで確認してください' : error instanceof Error ? error.message : 'Gmailの設定を確認できません');
        }
        finally {
            this.busy.delete(account.id);
        }
    }
    async reconcile(id) {
        const row = this.state.gmailFilters?.find(r => r.id === id && r.status === 'uncertain');
        if (!row)
            throw Error('結果確認待ちの設定がありません');
        const account = this.account(row.accountId);
        if (this.busy.has(account.id))
            throw Error('このGmail設定を操作中です');
        this.busy.add(account.id);
        try {
            if (row.kind === 'create') {
                const listed = await this.request(account, ''), candidates = (listed?.filter || []).filter((f) => !row.beforeIds?.includes(String(f.id)) && this.same(f, row.sender));
                if (candidates.length !== 1)
                    throw Error('作成結果を一意に確認できません。Gmail公式画面でフィルター設定を確認してください');
                row.remoteId = String(candidates[0].id);
            }
            else {
                if (await this.request(account, '/' + encodeURIComponent(row.remoteId)))
                    throw Error('対象フィルターはまだ存在します。自動削除は行いません');
                const source = this.state.gmailFilters?.find(r => r.id === row.sourceId);
                if (source)
                    source.removedAt = Date.now();
            }
            row.status = 'done';
            row.finishedAt = Date.now();
            delete row.beforeIds;
            this.save();
            return { confirmed: true };
        }
        finally {
            this.busy.delete(account.id);
        }
    }
    discard(id) { const row = this.state.gmailFilters?.find(r => r.id === id && r.status === 'pending'); if (!row)
        throw Error('取り消せる設定がありません'); this.state.gmailFilters = this.state.gmailFilters?.filter(r => r !== row); this.save(); }
}
