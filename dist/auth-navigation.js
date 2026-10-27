export function allowAuthPopup(service, value) {
    try {
        const url = new URL(value);
        return service === 'slack' && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'));
    }
    catch {
        return false;
    }
}
export function slackTokenFromBody(body) {
    if (body.length > 1024 * 1024)
        return;
    const candidates = [new URLSearchParams(body).get('token')];
    try {
        candidates.push(JSON.parse(body)?.token);
    }
    catch { }
    candidates.push(body.match(/(?:^|\r?\n)Content-Disposition:[^\r\n]*\bname="token"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n(xox[bpc]-[^\s\r\n]+)/i)?.[1] || null);
    return candidates.find(value => typeof value === 'string' && /^xox[bpc]-[a-zA-Z0-9-]+$/.test(value)) || undefined;
}
export function slackBrowserUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'slack:')
            return;
        const team = url.searchParams.get('team'), channel = url.searchParams.get('id');
        if (!team || !/^T[A-Z0-9]+$/.test(team))
            return;
        return 'https://app.slack.com/client/' + team + (channel && /^[CDG][A-Z0-9]+$/.test(channel) ? '/' + channel : '');
    }
    catch {
        return;
    }
}
