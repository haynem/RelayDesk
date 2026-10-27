import { MessengerEncrypted } from './messenger-e2ee.js';
import { desktopTunnel } from './desktop-tunnel.js';
import { desktopMailOAuth } from './desktop-mail-oauth.js';
import { desktopFiles } from './desktop-files.js';
import { DesktopNotifications } from './desktop-notifications.js';
import { setupTray } from './desktop-tray.js';
import { ServiceWindows } from './service-windows.js';
import { app, BrowserWindow, safeStorage, dialog, powerMonitor, powerSaveBlocker } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.js';
import { startServer } from './server.js';
import { InstagramRuntime } from './instagram-runtime.js';
import { ImapAdapter } from './adapters/imap.js';
import { SlackAdapter } from './adapters/slack.js';
import { SendyAdapter } from './adapters/sendy.js';
import { diagnosticSummary } from './diagnostics.js';
import { BrowserAuth } from './browser-auth.js';
import { MessengerAdapter } from './adapters/messenger.js';
import { shell } from 'electron';
import { LineAdapter } from './adapters/line.js';
import { DiscordAdapter } from './adapters/discord.js';
import { MatrixAdapter } from './adapters/matrix.js';
app.setName('RelayDesk');
if (process.platform === 'win32')
    app.setAppUserModelId('jp.relaydesk.private');
app.setPath('userData', join(app.getPath('appData'), 'RelayDesk-private'));
if (!app.requestSingleInstanceLock())
    app.exit(0);
let window;
app.on('second-instance', (_event, args) => { if (!app.isPackaged && args.includes('--request-quit')) {
    app.quit();
    return;
} window?.show(); window?.focus(); });
void app.whenReady().then(async () => {
    try {
        if (!await safeStorage.isAsyncEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'))
            throw Error('OSの安全な鍵保存機能を利用できません。起動を停止しました。');
        const dir = app.getPath('userData');
        mkdirSync(dir, { recursive: true });
        const keyFile = join(dir, 'master-key.bin');
        let key;
        if (existsSync(keyFile))
            key = Buffer.from((await safeStorage.decryptStringAsync(readFileSync(keyFile))).result, 'hex');
        else {
            key = randomBytes(32);
            writeFileSync(keyFile, await safeStorage.encryptStringAsync(key.toString('hex')), { mode: 0o600 });
        }
        const notifications = new DesktopNotifications(() => { window?.show(); window?.focus(); if (window && !window.isDestroyed())
            void window.webContents.executeJavaScript("document.querySelector('[data-view=attention]').click()").catch(() => { }); });
        const vault = new Vault(dir, key);
        vault.save();
        let sleepBlocker;
        const setPreventSleep = (enabled) => { if (sleepBlocker !== undefined) {
            powerSaveBlocker.stop(sleepBlocker);
            sleepBlocker = undefined;
        } if (enabled)
            sleepBlocker = powerSaveBlocker.start('prevent-app-suspension'); };
        setPreventSleep(vault.state.background?.preventSleep === true);
        if (process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && vault.state.background?.launchAtLogin === undefined) {
            app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe') });
            vault.state.background = { ...vault.state.background, preventSleep: vault.state.background?.preventSleep || false, launchAtLogin: true };
            vault.save();
        }
        const instagram = new InstagramRuntime(), line = new LineAdapter(), browserAuth = new BrowserAuth(), serviceWindows = new ServiceWindows(id => vault.state.accounts.find(a => a.id === id), () => vault.save(), () => window);
        const messengerHelper = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'native/bin/messenger-helper' + (process.platform === 'win32' ? '.exe' : '')), messengerEncrypted = new MessengerEncrypted(vault, messengerHelper, targets => notifications.enqueue(targets));
        const backend = await startServer(vault, join(dirname(fileURLToPath(import.meta.url)), '../ui'), { instagram: instagram.adapter, line, messenger: new MessengerAdapter(messengerHelper, undefined, messengerEncrypted), discord: new DiscordAdapter(), matrix: new MatrixAdapter(), imap: new ImapAdapter(), slack: new SlackAdapter(), sendy: new SendyAdapter() }, { ...desktopFiles(() => window), messengerEncrypted, quit: () => app.quit(), setPreventSleep, backgroundStatus: () => ({ preventSleep: sleepBlocker !== undefined && powerSaveBlocker.isStarted(sleepBlocker) }), startupStatus: () => ({ supported: process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE, enabled: process.platform === 'win32' && app.isPackaged && app.getLoginItemSettings().openAtLogin }), setStartup: enabled => { if (process.platform !== 'win32' || !app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE)
                throw Error('インストールしたWindows版で設定してください'); app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe') }); vault.state.background = { ...vault.state.background, preventSleep: vault.state.background?.preventSleep || false, launchAtLogin: enabled }; vault.save(); }, openTunnel: desktopTunnel(dir), tunnelSupported: process.platform === 'win32' && process.arch === 'x64', mailLogin: desktopMailOAuth(() => window), openLink: async (url) => { const result = await dialog.showMessageBox(window, { type: 'question', buttons: ['戻る', 'ブラウザーで開く'], defaultId: 0, cancelId: 0, message: 'メッセージ内のリンクを開きますか？', detail: url }); if (result.response === 1)
                await shell.openExternal(url); }, notify: targets => notifications.enqueue(targets), notificationSupported: () => notifications.supported(), testNotification: () => notifications.test(), notificationSettingsChanged: () => notifications.clear(), openService: (service, id, bounds, threadId) => serviceWindows.open(service, id, bounds, threadId), hideService: () => serviceWindows.hide(), serviceBounds: bounds => serviceWindows.setBounds(bounds), reloadService: () => serviceWindows.reload(), instagramLogin: () => instagram.login(), lineLogin: (qr, pin) => line.login(qr, pin), adoptLineLogin: (fromId, toId) => line.adoptLogin(fromId, toId), serviceLogin: service => browserAuth.login(service), resetConnection: async (id) => { await messengerEncrypted.stop(id); line.forget(id); await instagram.forget(id); await serviceWindows.forget(id); }, forget: async (id) => { await messengerEncrypted.forget(id); line.forget(id); await instagram.forget(id); await serviceWindows.forget(id); } });
        let closing = false, exitReady = false;
        window = new BrowserWindow({ width: 1380, height: 900, minWidth: 980, minHeight: 650, backgroundColor: '#f6f7fa', title: 'RelayDesk', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
        window.setMenuBarVisibility(false);
        window.webContents.setWindowOpenHandler(({ url }) => { if (url === 'https://myaccount.google.com/apppasswords')
            void shell.openExternal(url); return { action: 'deny' }; });
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        await window.loadURL(`http://127.0.0.1:${backend.port}/#${backend.session}`);
        window.show();
        window.focus();
        const tray = setupTray(window, join(app.getAppPath(), 'ui/tray.png'), { sync: () => backend.sync(), quit: () => app.quit(), isQuitting: () => closing });
        const report = () => { if (process.argv.includes('--diagnostics'))
            process.stdout.write(JSON.stringify(diagnosticSummary(vault.state)) + '\n'); };
        const verifyLocalUI = async () => {
            if (!process.argv.includes('--verify-local-ui'))
                return;
            // Render saved real data locally, but emit counts/booleans only. No screenshots or body logging.
            const verifier = new BrowserWindow({ show: false, width: 1380, height: 900, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
            try {
                await verifier.loadURL(`http://127.0.0.1:${backend.port}/#${backend.session}`);
                const result = await verifier.webContents.executeJavaScript(`(async()=>{
        for(let n=0;n<100&&!document.querySelector('[data-attention-open]')&&!document.querySelector('#first-connect');n++)await new Promise(r=>setTimeout(r,50));
        const priorityCards=document.querySelectorAll('.attention-card').length;
        document.querySelector('[data-view="inbox"]').click();
        for(let n=0;n<100&&!document.querySelector('[data-thread]');n++)await new Promise(r=>setTimeout(r,50));
        const rows=[...document.querySelectorAll('[data-thread]')];const renderedThreads=rows.length;
        if(!rows.length)return{priorityCards,renderedThreads,bodyElements:0,searchPassed:false};
        const term=rows[0].querySelector('strong').textContent;
        const input=document.querySelector('#search');input.value=term;input.dispatchEvent(new Event('input'));
        const searchPassed=document.querySelectorAll('[data-thread]').length>0;
        document.querySelector('#search').value='';document.querySelector('#search').dispatchEvent(new Event('input'));
        for(const row of [...document.querySelectorAll('[data-thread]')]){row.click();if(document.querySelectorAll('.message').length)break;}
        return{priorityCards,renderedThreads,bodyElements:document.querySelectorAll('.message').length,searchPassed};
      })()`);
                process.stdout.write('local-ui ' + JSON.stringify(result) + '\n');
            }
            catch {
                process.stdout.write('local-ui ' + JSON.stringify({ error: true }) + '\n');
            }
            finally {
                verifier.destroy();
            }
        };
        report();
        if (process.argv.includes('--discord-setup')) {
            const applicationId = process.argv.find(arg => arg.startsWith('--discord-client-id='))?.split('=')[1];
            await window.webContents.executeJavaScript(`(async()=>{document.querySelector('[data-view="connections"]').click();for(let i=0;i<100&&!document.querySelector('#discord-rpc-connect');i++)await new Promise(r=>setTimeout(r,50));document.querySelector('#discord-rpc-connect')?.click();const input=document.querySelector('dialog [name="clientId"]');if(input&&${JSON.stringify(!!applicationId && /^\d{15,22}$/.test(applicationId))})input.value=${JSON.stringify(applicationId || '')};})()`);
        }
        powerMonitor.on('resume', () => void backend.sync().then(report));
        void backend.sync().then(async () => { report(); await verifyLocalUI(); });
        if (process.argv.includes('--auth-setup')) {
            await window.webContents.executeJavaScript("document.querySelector('[data-view=\"connections\"]').click()");
            backend.beginLineLogin();
            backend.beginServiceLogin('slack');
            backend.beginServiceLogin('messenger');
            await shell.openExternal('https://myaccount.google.com/apppasswords');
        }
        if (process.argv.includes('--instagram-login'))
            backend.beginInstagramLogin();
        if (process.argv.includes('--slack-login')) {
            await window.webContents.executeJavaScript("document.querySelector('[data-view=\"connections\"]').click()");
            backend.beginServiceLogin('slack');
        }
        if (process.argv.includes('--prepare-mail-test')) {
            backend.prepareSelfMailTest();
            await window.webContents.executeJavaScript("document.querySelector('[data-view=drafts]').click()");
        }
        if (process.argv.includes('--gmail-setup'))
            await window.webContents.executeJavaScript("document.querySelector('[data-view=\"connections\"]').click();document.querySelector('#add-account').click();document.querySelector('#connect-form').elements.adapter.value='imap';document.querySelector('#connect-form').elements.adapter.dispatchEvent(new Event('change'))");
        app.on('before-quit', event => { if (exitReady)
            return; event.preventDefault(); if (closing)
            return; closing = true; notifications.clear(); setPreventSleep(false); line.persist(vault.state.accounts); vault.save(); void Promise.allSettled([serviceWindows.closeAll(), backend.close(), messengerEncrypted.close()]).finally(() => { exitReady = true; tray?.dispose(); app.quit(); }); });
        app.on('window-all-closed', () => { if (!tray)
            app.quit(); });
    }
    catch {
        dialog.showErrorBox('RelayDeskを起動できません', '暗号化データまたはOSの鍵保存を確認してください。既存データは上書きしていません。');
        app.quit();
    }
});
