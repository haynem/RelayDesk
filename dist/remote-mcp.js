import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mcp } from './mcp.js';
const token = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const scopeRead = 'relaydesk.read', scopeDraft = 'relaydesk.drafts';
const allowedRedirect = (value) => { try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'chatgpt.com' && !u.port && !u.username && !u.password && !u.hash && !u.search && (u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(u.pathname));
}
catch {
    return false;
} };
async function readBody(request) { let data = ''; for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 100000)
        throw Error('Request too large');
} return data; }
function canonicalOrigin(value) { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    throw Error('公開用HTTPSアドレスはパスを含まない形式で指定してください'); return url.origin; }
export class RemoteMcp {
    state;
    save;
    instanceId = randomBytes(16).toString('hex');
    server;
    error = '';
    registrations = [];
    constructor(state, save) {
        this.state = state;
        this.save = save;
    }
    config() { return this.state.remoteMcp ??= { enabled: false, origin: '', port: 18765, clients: [], authorizations: [], grants: [] }; }
    status() {
        const c = this.config(), now = Date.now();
        return { enabled: c.enabled, listening: !!this.server?.listening, error: this.error, origin: c.origin, port: c.port, endpoint: c.origin ? c.origin + '/mcp' : '', localEndpoint: 'http://127.0.0.1:' + c.port + '/mcp', externallyPublished: false,
            pending: c.authorizations.filter(a => !a.approved && !a.denied && a.at > now - 600000).map(a => ({ id: a.id, clientName: c.clients.find(x => x.id === a.clientId)?.name || '接続要求', redirect: a.redirect, verificationCode: a.id.slice(0, 8), scopes: a.scopes, at: a.at })),
            grants: c.grants.filter(g => !g.revoked && g.refreshExpiresAt > now).map(g => ({ id: g.id, clientName: c.clients.find(x => x.id === g.clientId)?.name || '接続済みクライアント', createdAt: g.createdAt, expiresAt: g.expiresAt, scopes: g.scopes, accounts: g.shares.map(s => s.accountId) })) };
    }
    async configure(input) {
        if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535)
            throw Error('接続設定が無効です');
        const origin = input.enabled ? canonicalOrigin(input.origin) : input.origin ? canonicalOrigin(input.origin) : '';
        await this.close();
        const c = this.config();
        if (c.origin !== origin || !input.enabled) {
            c.authorizations = [];
            for (const g of c.grants)
                g.revoked = true;
        }
        Object.assign(c, { enabled: input.enabled, origin, port: input.port });
        this.save();
        await this.restore();
        return this.status();
    }
    async restore() {
        const c = this.state.remoteMcp;
        if (!c?.enabled || this.server)
            return;
        try {
            canonicalOrigin(c.origin);
            const server = createServer((request, response) => void this.handle(request, response).catch(() => this.json(response, 400, { error: 'invalid_request' })));
            this.server = server;
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.port, '127.0.0.1', () => resolve()); });
            server.on('error', () => { this.error = '接続準備用ポートでエラーが発生しました'; });
            this.error = '';
        }
        catch {
            this.server = undefined;
            this.error = '接続準備用ポートを利用できません。別のポート番号を指定してください';
        }
    }
    async close() { const server = this.server; this.server = undefined; if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
    } }
    approve(id, accept, allowDrafts) {
        const c = this.config(), a = c.authorizations.find(a => a.id === id && !a.approved && !a.denied && a.at > Date.now() - 600000);
        if (!a)
            throw Error('有効な接続要求がありません');
        if (!accept) {
            a.denied = true;
            this.save();
            return;
        }
        a.shares = this.state.accounts.filter(a => a.aiAllowed).map(a => ({ accountId: a.id, scope: a.aiScope || 'all', threadIds: [...(a.aiThreadIds || [])] }));
        if (!a.shares.length)
            throw Error('先に共有するアカウント・会話を選んでください');
        if (!allowDrafts || !this.state.draftAllowed)
            a.scopes = a.scopes.filter(s => s !== scopeDraft);
        a.approved = true;
        a.code = token();
        a.codeHash = hash(a.code);
        this.save();
    }
    revoke(id) { const grant = this.config().grants.find(g => g.id === id); if (!grant)
        throw Error('接続がありません'); grant.revoked = true; this.save(); }
    json(response, status, value, headers = {}) { if (response.headersSent)
        return; response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); response.end(JSON.stringify(value)); }
    resource() { return this.config().origin + '/mcp'; }
    prune() { const c = this.config(), now = Date.now(); c.authorizations = c.authorizations.filter(a => a.at > now - 600000).slice(-24); c.grants = c.grants.filter(g => g.refreshExpiresAt > now).slice(-128); }
    async handle(request, response) {
        const c = this.config(), host = String(request.headers.host || '');
        if (!c.enabled || ![new URL(c.origin).host, '127.0.0.1:' + c.port, 'localhost:' + c.port].includes(host))
            return this.json(response, 403, { error: 'host_denied' });
        const url = new URL(request.url || '/', c.origin), path = url.pathname, origin = request.headers.origin;
        if (origin && origin !== 'https://chatgpt.com' && origin !== c.origin)
            return this.json(response, 403, { error: 'origin_denied' });
        if (origin)
            response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        if (request.method === 'OPTIONS') {
            response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,MCP-Protocol-Version' });
            response.end();
            return;
        }
        this.prune();
        if (request.method === 'GET' && path === '/.well-known/relaydesk-instance')
            return this.json(response, 200, { instance: this.instanceId, resource: this.resource() });
        if (request.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp'))
            return this.json(response, 200, { resource: this.resource(), authorization_servers: [c.origin], scopes_supported: [scopeRead, scopeDraft], bearer_methods_supported: ['header'] });
        if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server')
            return this.json(response, 200, { issuer: c.origin, authorization_response_iss_parameter_supported: true, authorization_endpoint: c.origin + '/oauth/authorize', token_endpoint: c.origin + '/oauth/token', registration_endpoint: c.origin + '/oauth/register', revocation_endpoint: c.origin + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: [scopeRead, scopeDraft] });
        if (path === '/oauth/register' && request.method === 'POST') {
            const now = Date.now();
            this.registrations = this.registrations.filter(at => at > now - 600000);
            if (this.registrations.length >= 24 || c.clients.length >= 128)
                return this.json(response, 429, { error: 'registration_limit' });
            this.registrations.push(now);
            const input = JSON.parse(await readBody(request));
            if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 4 || input.redirect_uris.some((r) => typeof r !== 'string' || !allowedRedirect(r)) || input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none')
                return this.json(response, 400, { error: 'invalid_client_metadata' });
            const client = { id: token(), name: typeof input.client_name === 'string' ? input.client_name.slice(0, 100) : 'ChatGPT接続', redirects: [...new Set(input.redirect_uris)], at: now };
            c.clients.push(client);
            this.save();
            return this.json(response, 201, { client_id: client.id, client_id_issued_at: Math.floor(now / 1000), client_name: client.name, redirect_uris: client.redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
        }
        if (path === '/oauth/authorize' && request.method === 'GET') {
            const q = url.searchParams, client = c.clients.find(x => x.id === q.get('client_id')), redirect = q.get('redirect_uri') || '', challenge = q.get('code_challenge') || '', resource = q.get('resource') || '', scopes = (q.get('scope') || scopeRead).split(/\s+/).filter(Boolean);
            if (!client || !client.redirects.includes(redirect) || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || resource !== this.resource() || scopes.some(s => ![scopeRead, scopeDraft].includes(s)) || !scopes.includes(scopeRead) || (q.get('state') || '').length > 2048 || c.authorizations.filter(a => !a.used && !a.denied).length >= 20)
                return this.json(response, 400, { error: 'invalid_authorization_request' });
            const authorization = { id: token(), clientId: client.id, redirect, state: q.get('state') || '', challenge, resource, scopes, at: Date.now() };
            c.authorizations.push(authorization);
            this.save();
            const nonce = token();
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
            response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>RelayDeskへの接続</title><h1>RelayDeskで接続を承認してください</h1><p>PCのRelayDeskを開き、「ChatGPT連携」に表示された接続要求・共有範囲を確認してください。承認するとこの画面からChatGPTへ戻ります。</p><p>確認コード：<strong>${authorization.id.slice(0, 8)}</strong></p><p>RelayDeskに表示される同じコードの要求だけを承認してください。</p><p id="status">承認を待っています。10分で期限切れになります。</p><script nonce="${nonce}">const timer=setInterval(async()=>{try{const r=await fetch('/oauth/pending/${authorization.id}',{cache:'no-store'});const s=await r.json();if(s.redirect){clearInterval(timer);location.replace(s.redirect);}else if(s.expired){clearInterval(timer);document.getElementById('status').textContent='期限切れです。ChatGPTから接続をやり直してください。';}}catch{}},2000);</script></html>`);
            return;
        }
        if (path.startsWith('/oauth/pending/') && request.method === 'GET') {
            const a = c.authorizations.find(a => a.id === path.slice('/oauth/pending/'.length));
            if (!a || a.delivered)
                return this.json(response, 200, { expired: true });
            if (a.approved || a.denied) {
                const target = new URL(a.redirect);
                target.searchParams.set('state', a.state);
                target.searchParams.set('iss', c.origin);
                if (a.denied)
                    target.searchParams.set('error', 'access_denied');
                else
                    target.searchParams.set('code', a.code);
                a.delivered = true;
                delete a.code;
                this.save();
                return this.json(response, 200, { redirect: target.href });
            }
            return this.json(response, 200, { pending: true });
        }
        if (path === '/oauth/token' && request.method === 'POST') {
            if (!String(request.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded'))
                return this.json(response, 415, { error: 'invalid_request' });
            const form = new URLSearchParams(await readBody(request)), clientId = form.get('client_id') || '', resource = form.get('resource') || '';
            if (resource !== this.resource())
                return this.json(response, 400, { error: 'invalid_target' });
            let grant;
            if (form.get('grant_type') === 'authorization_code') {
                const code = form.get('code') || '', verifier = form.get('code_verifier') || '', a = c.authorizations.find(a => a.clientId === clientId && a.approved && !a.denied && !a.used && a.resource === resource && a.codeHash && equal(a.codeHash, hash(code)));
                if (!a || a.redirect !== form.get('redirect_uri') || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(a.challenge, createHash('sha256').update(verifier).digest('base64url')))
                    return this.json(response, 400, { error: 'invalid_grant' });
                a.used = true;
                grant = { id: token(), clientId, accessHash: '', refreshHash: '', expiresAt: 0, refreshExpiresAt: 0, resource, scopes: a.scopes, shares: a.shares, createdAt: Date.now() };
                c.grants.push(grant);
            }
            else if (form.get('grant_type') === 'refresh_token') {
                const refresh = form.get('refresh_token') || '';
                grant = c.grants.find(g => !g.revoked && g.clientId === clientId && g.resource === resource && g.refreshExpiresAt > Date.now() && equal(g.refreshHash, hash(refresh)));
                if (!grant)
                    return this.json(response, 400, { error: 'invalid_grant' });
            }
            else
                return this.json(response, 400, { error: 'unsupported_grant_type' });
            const access = token(), refresh = token();
            grant.accessHash = hash(access);
            grant.refreshHash = hash(refresh);
            grant.expiresAt = Date.now() + 3600000;
            grant.refreshExpiresAt = Date.now() + 30 * 86400000;
            this.save();
            return this.json(response, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: grant.scopes.join(' ') });
        }
        if (path === '/oauth/revoke' && request.method === 'POST') {
            const form = new URLSearchParams(await readBody(request)), value = hash(form.get('token') || '');
            for (const g of c.grants)
                if (g.clientId === form.get('client_id') && (equal(value, g.accessHash) || equal(value, g.refreshHash)))
                    g.revoked = true;
            this.save();
            return this.json(response, 200, {});
        }
        if (path === '/mcp') {
            const authorization = String(request.headers.authorization || ''), presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '', grant = c.grants.find(g => !g.revoked && g.expiresAt > Date.now() && g.resource === this.resource() && g.scopes.includes(scopeRead) && equal(g.accessHash, hash(presented)));
            if (!presented || !grant)
                return this.json(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${c.origin}/.well-known/oauth-protected-resource/mcp"` });
            if (request.method !== 'POST')
                return this.json(response, 405, { error: 'post_required' });
            const requestBody = JSON.parse(await readBody(request)), accounts = this.state.accounts.map(a => {
                const share = grant.shares.find(s => s.accountId === a.id);
                if (!share || !a.aiAllowed)
                    return { ...a, aiAllowed: false };
                const all = share.scope === 'all' && a.aiScope !== 'selected', ids = share.scope === 'all' ? [...(a.aiThreadIds || [])] : a.aiScope === 'selected' ? share.threadIds.filter(id => a.aiThreadIds?.includes(id)) : share.threadIds;
                return { ...a, aiAllowed: true, aiScope: all ? 'all' : 'selected', aiThreadIds: ids };
            });
            const scoped = { ...this.state, accounts, draftAllowed: this.state.draftAllowed && grant.scopes.includes(scopeDraft) }, result = mcp(scoped, requestBody);
            this.save();
            if (result === null) {
                response.writeHead(202);
                response.end();
                return;
            }
            return this.json(response, 200, result);
        }
        return this.json(response, 404, { error: 'not_found' });
    }
}
