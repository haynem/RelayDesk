import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export class AssetStore {
    key;
    dir;
    constructor(dir, key) {
        this.key = key;
        this.dir = join(dir, 'assets');
    }
    path(id) { if (!/^[a-f0-9]{64}$/.test(id))
        throw Error('添付の識別子が無効です'); return join(this.dir, id + '.enc'); }
    put(asset) {
        if (!Buffer.isBuffer(asset.data) || asset.data.length > MAX_ASSET_BYTES)
            throw Error('添付は1ファイル25MBまでです');
        const file = this.path(asset.id), sha256 = createHash('sha256').update(asset.data).digest('hex');
        mkdirSync(this.dir, { recursive: true });
        if (!existsSync(file)) {
            const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
            cipher.setAAD(Buffer.from('relaydesk-asset:' + asset.id));
            const encrypted = Buffer.concat([cipher.update(asset.data), cipher.final()]);
            writeFileSync(file + '.tmp', Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
            renameSync(file + '.tmp', file);
        }
        return { id: asset.id, accountId: asset.accountId, threadId: asset.threadId, messageId: asset.messageId, draftId: asset.draftId, name: String(asset.name || 'attachment').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 255), mime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(asset.mime) ? asset.mime : 'application/octet-stream', size: asset.data.length, sha256, createdAt: Date.now() };
    }
    read(asset) { const raw = readFileSync(this.path(asset.id)); if (raw.length < 28 || raw.length > MAX_ASSET_BYTES + 28)
        throw Error('添付データが無効です'); const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); decipher.setAAD(Buffer.from('relaydesk-asset:' + asset.id)); const data = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]); if (createHash('sha256').update(data).digest('hex') !== asset.sha256)
        throw Error('添付データの整合性を確認できません'); return data; }
    remove(id) { const file = this.path(id); if (existsSync(file))
        unlinkSync(file); }
}
export function assetId(accountId, messageId, index, data) { return createHash('sha256').update(accountId + '\0' + messageId + '\0' + index + '\0').update(data).digest('hex'); }
export function assetForMessage(state, accountId, threadId, messageId, assetId) {
    const message = state.messages.find(m => m.accountId === accountId && m.threadId === threadId && m.id === messageId);
    if (!message?.attachments.some(f => f.blobId === assetId))
        throw Error('このメッセージの添付がありません');
    const asset = state.assets?.find(f => f.id === assetId && f.accountId === accountId && f.threadId === threadId && f.messageId === messageId);
    if (!asset)
        throw Error('添付の実体はまだ取得されていません');
    return asset;
}
export function rememberAsset(state, asset) { const assets = state.assets ??= []; const at = assets.findIndex(x => x.id === asset.id); if (at < 0)
    assets.push(asset);
else
    assets[at] = asset; }
