/** Merge a completed read without replacing credentials refreshed by a concurrent connection. */
export function mergeConfig(current, baseline, updated) {
    for (const [name, value] of Object.entries(updated))
        if (current[name] === baseline[name])
            current[name] = value;
}
/** Native cookie refreshes travel only over the private pipe and into the encrypted vault. */
export function absorbMessengerCookies(account, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const fresh = value;
    if (fresh.c_user !== account.config.viewerId || Object.entries(fresh).some(([name, v]) => !/^[_a-zA-Z0-9-]{1,100}$/.test(name) || typeof v !== 'string' || v.length > 16384 || /[\r\n;]/.test(v)))
        return false;
    const stored = JSON.parse(account.config.cookies || '[]');
    let changed = false;
    for (const [name, value] of Object.entries(fresh)) {
        const cookie = stored.find(c => c.name === name);
        if (cookie?.value === value)
            continue;
        if (cookie) {
            cookie.value = value;
            delete cookie.expirationDate;
        }
        else
            stored.push({ name, value, domain: '.facebook.com', path: '/', secure: true, httpOnly: true });
        changed = true;
    }
    if (changed)
        account.config.cookies = JSON.stringify(stored);
    return changed;
}
