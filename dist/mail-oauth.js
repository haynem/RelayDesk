import { createServer } from 'node:http';
import { randomBytes, createHash, randomUUID, createPublicKey, verify } from 'node:crypto';
const endpoints = { google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'openid email https://mail.google.com/' }, microsoft: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'openid email profile offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send' } };
const random = () => randomBytes(32).toString('base64url');
async function tokenRequest(provider, params) {
    const response = await fetch(endpoints[provider].token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(30000), redirect: 'error' });
    const data = await response.json();
    if (!response.ok || typeof data.access_token !== 'string' || !Number.isFinite(Number(data.expires_in)))
        throw Error('メールの認証が失効したか、OAuth登録設定が一致していません。公式ログインから再接続してください');
    return data;
}
const refreshing = new Map();
export async function mailAccessToken(account) {
    const c = account.config;
    if (!['google', 'microsoft'].includes(c.oauthProvider))
        throw Error('メールのOAuth設定がありません');
    if (c.oauthAccessToken && Number(c.oauthExpiresAt) > Date.now() + 60000)
        return c.oauthAccessToken;
    if (refreshing.has(account.id))
        return refreshing.get(account.id);
    const job = (async () => { if (!c.oauthRefreshToken)
        throw Error('公式ログインからメールを再接続してください'); const data = await tokenRequest(c.oauthProvider, { grant_type: 'refresh_token', client_id: c.oauthClientId, refresh_token: c.oauthRefreshToken, ...(c.oauthClientSecret ? { client_secret: c.oauthClientSecret } : {}), ...(c.oauthProvider === 'microsoft' ? { scope: endpoints.microsoft.scope } : {}) }); c.oauthAccessToken = data.access_token; c.oauthExpiresAt = String(Date.now() + Number(data.expires_in) * 1000); if (typeof data.refresh_token === 'string')
        c.oauthRefreshToken = data.refresh_token; return c.oauthAccessToken; })();
    refreshing.set(account.id, job);
    try {
        return await job;
    }
    finally {
        refreshing.delete(account.id);
    }
}
export async function mailAuth(account) { return account.config.oauthProvider ? { user: account.config.user, accessToken: await mailAccessToken(account) } : { user: account.config.user, pass: account.config.password }; }
async function microsoftIdentity(jwt, clientId, nonce) {
    const parts = jwt?.split('.');
    if (parts?.length !== 3 || jwt.length > 30000)
        throw Error('Microsoftの本人情報を確認できません');
    let header, claims;
    try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    }
    catch {
        throw Error('Microsoftの本人情報が無効です');
    }
    const now = Date.now() / 1000;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || claims.aud !== clientId || claims.nonce !== nonce || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60) || typeof claims.tid !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.tid) || claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`)
        throw Error('Microsoftの本人情報が一致しません');
    const response = await fetch('https://login.microsoftonline.com/common/discovery/v2.0/keys', { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok)
        throw Error('Microsoftの署名鍵を取得できません');
    const keys = await response.json(), key = keys.keys?.find((k) => k.kid === header.kid && k.kty === 'RSA' && k.use === 'sig' && (!k.issuer || k.issuer.replace('{tenantid}', claims.tid) === claims.iss));
    if (!key || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url')))
        throw Error('Microsoftの署名を確認できません');
    return { email: String(claims.email || claims.preferred_username || ''), name: String(claims.name || ''), id: String(claims.sub || '') };
}
/** Opens only the official OAuth endpoint; the random loopback callback closes after one use. */
export async function loginMailOAuth(input, open) {
    if (!Object.hasOwn(endpoints, input.provider) || !input.clientId || input.clientId.length > 500 || input.clientSecret && input.clientSecret.length > 1000)
        throw Error('OAuthのアプリ登録情報を確認してください');
    const provider = input.provider, verifier = random(), state = random(), nonce = random();
    let port = 0, timer;
    let settle = () => { }, used = false;
    const server = createServer((request, response) => {
        const finish = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer' }); response.end(text); };
        if (request.headers.host !== `127.0.0.1:${port}` || request.method !== 'GET')
            return finish(400, '無効な認証応答です');
        const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state || used)
            return finish(400, '認証応答が一致しません');
        used = true;
        const code = url.searchParams.get('code');
        finish(code ? 200 : 400, code ? '認証を受け取りました。RelayDeskへ戻ってください。' : '認証は完了しませんでした。RelayDeskからやり直してください。');
        settle(code || undefined);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }); });
    const callback = `http://127.0.0.1:${port}/oauth/callback`, authorization = new URL(endpoints[provider].authorize), params = { client_id: input.clientId, response_type: 'code', redirect_uri: callback, scope: endpoints[provider].scope + (provider === 'google' && input.gmailFilters ? ' https://www.googleapis.com/auth/gmail.settings.basic' : ''), state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent select_account' } : { prompt: 'select_account' }) };
    for (const [key, value] of Object.entries(params))
        authorization.searchParams.set(key, value);
    try {
        const result = new Promise(resolve => { settle = resolve; timer = setTimeout(() => resolve(undefined), 600000); });
        await open(authorization.href);
        const code = await result;
        if (!code)
            throw Error('メールのログインは完了していません');
        const tokens = await tokenRequest(provider, { grant_type: 'authorization_code', client_id: input.clientId, code, redirect_uri: callback, code_verifier: verifier, ...(input.clientSecret ? { client_secret: input.clientSecret } : {}) });
        let user;
        if (provider === 'google') {
            const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token }, redirect: 'error', signal: AbortSignal.timeout(20000) }), data = await response.json();
            if (!response.ok || data.verified_email !== true)
                throw Error('Googleのメールアドレスを確認できません');
            user = { email: String(data.email || ''), name: String(data.name || ''), id: String(data.id || '') };
        }
        else
            user = await microsoftIdentity(tokens.id_token, input.clientId, nonce);
        if (!user.id || !/^[^\s@<>,;:"()]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(user.email))
            throw Error('ログインしたメールアドレスを確認できません');
        return { id: randomUUID(), service: 'email', adapter: 'imap', name: (provider === 'google' ? 'Gmail' : 'Outlook') + ' · ' + user.email, aiAllowed: false, config: { user: user.email, viewerId: user.id, host: provider === 'google' ? 'imap.gmail.com' : 'outlook.office365.com', port: '993', smtpHost: provider === 'google' ? 'smtp.gmail.com' : 'smtp.office365.com', smtpPort: provider === 'google' ? '465' : '587', oauthProvider: provider, oauthScopes: String(tokens.scope || params.scope), oauthClientId: input.clientId, oauthClientSecret: input.clientSecret || '', oauthAccessToken: tokens.access_token, oauthRefreshToken: tokens.refresh_token || '', oauthExpiresAt: String(Date.now() + Number(tokens.expires_in) * 1000) } };
    }
    finally {
        if (timer)
            clearTimeout(timer);
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
    }
}
