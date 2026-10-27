import { createCipheriv, createDecipheriv, randomBytes, createHash, hkdfSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AssetStore } from './assets.js';
export class Vault {
    dir;
    secret;
    state;
    assets;
    constructor(dir, secret) {
        this.dir = dir;
        this.secret = secret;
        if (secret.length !== 32)
            throw Error('Invalid key');
        this.assets = new AssetStore(dir, secret);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'state.enc');
        if (existsSync(file)) {
            const raw = readFileSync(file);
            const decipher = createDecipheriv('aes-256-gcm', secret, raw.subarray(0, 12));
            decipher.setAuthTag(raw.subarray(12, 28));
            this.state = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
        }
        else
            this.state = { accounts: [], threads: [], messages: [], drafts: [], mcpToken: randomBytes(32).toString('hex'), draftAllowed: false };
    }
    nativeStore(accountId) { const directory = join(this.dir, 'messenger-e2ee'); mkdirSync(directory, { recursive: true, mode: 0o700 }); const name = createHash('sha256').update(accountId).digest('hex') + '.sqlite', key = Buffer.from(hkdfSync('sha256', this.secret, Buffer.from(accountId), Buffer.from('RelayDesk Messenger encrypted device store v1'), 32)).toString('hex'); return { path: join(directory, name), key }; }
    save() { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.secret, nonce); const body = Buffer.concat([cipher.update(JSON.stringify(this.state), 'utf8'), cipher.final()]); const tmp = join(this.dir, 'state.tmp'); writeFileSync(tmp, Buffer.concat([nonce, cipher.getAuthTag(), body]), { mode: 0o600 }); renameSync(tmp, join(this.dir, 'state.enc')); }
}
