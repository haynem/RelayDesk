// Development UI test. Uses synthetic fixtures only and an isolated temporary profile.
const {app,BrowserWindow,safeStorage}=require('electron');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const profile=mkdtempSync(path.join(tmpdir(),'relay-ui-'));app.setPath('userData',profile);
let backend;
app.whenReady().then(async()=>{
 try{
  const {Vault}=await import('../dist/vault.js');const {startServer}=await import('../dist/server.js');
  if(!await safeStorage.isAsyncEncryptionAvailable())throw Error('OS encryption unavailable');
  const wrapped=await safeStorage.encryptStringAsync('fixture-key');if((await safeStorage.decryptStringAsync(wrapped)).result!=='fixture-key')throw Error('safeStorage failed');
  const vault=new Vault(profile,crypto.randomBytes(32));
  const fake={sync:async a=>({threads:[{id:'fixture-thread',accountId:a.id,title:'UI検証用の架空会話',isGroup:false,updatedAt:Date.now(),members:['テスト送信者'],membersComplete:false}],messages:[{id:'fixture-message',accountId:a.id,threadId:'fixture-thread',sender:'テスト送信者',text:'これは画面検証用の架空メッセージです。実サービスの接続成功を示すものではありません。',ts:Date.now(),isMe:false,attachments:[]}]})};
  backend=await startServer(vault,path.resolve('ui'),{imap:fake,slack:fake,sendy:fake});
  const win=new BrowserWindow({width:1380,height:900,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadURL(`http://127.0.0.1:${backend.port}/#${backend.session}`);
  const js=code=>win.webContents.executeJavaScript(code,true);
  const waitFor=async(expression)=>{for(let n=0;n<50;n++){if(await js(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI condition timeout: '+expression);};
  await waitFor(`document.querySelector('#first-connect')!==null`);
  const out=path.resolve('docs/verification');mkdirSync(out,{recursive:true});
  writeFileSync(path.join(out,'windows-empty.png'),(await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('#first-connect').click()`);
  if(!await js(`document.querySelector('#connect-dialog').open`))throw Error('Connect dialog did not open');
  if(!await js(`document.querySelector('#connect-form').elements.adapter.value==='instagram' && document.querySelector('#adapter-fields').innerText.includes('公式ログイン画面')`))throw Error('Instagram login guidance missing');
  await js(`document.querySelector('#connect-form').elements.adapter.value='slack';document.querySelector('#connect-form').elements.adapter.dispatchEvent(new Event('change'))`);
  if(!await js(`!document.querySelector('#adapter-fields input[name=token]') && document.querySelector('#adapter-fields').innerText.includes('トークンの準備は不要')`))throw Error('Slack must offer browser login without a token field');
  await js(`document.querySelector('#connect-form').elements.adapter.value='imap';document.querySelector('#connect-form').elements.adapter.dispatchEvent(new Event('change'))`);
  if(!await js(`document.querySelector('#connect-form').elements.host.value==='imap.gmail.com' && document.querySelector('#connect-form').elements.smtpHost.value==='smtp.gmail.com' && new FormData(document.querySelector('#connect-form')).get('name')==='Gmail'`))throw Error('Gmail preset or automatic account name missing');
  await js(`(()=>{const f=document.querySelector('#connect-form');f.elements.name.value='UIテスト用（架空）';f.elements.host.value='mail.example.test';f.elements.user.value='test@example.test';f.elements.password.value='synthetic';f.requestSubmit();})()`);
  await waitFor(`document.querySelector('#content').innerText.includes('UIテスト用（架空）')`);
  await backend.sync();await js(`document.querySelector('[data-view="inbox"]').click()`);
  await win.webContents.reload();
  await waitFor(`document.querySelector('[data-attention-open]')!==null`);
  await js(`document.querySelector('[data-view="inbox"]').click()`);
  if(!await js(`location.hash==='' && document.querySelector('#notice').innerText.indexOf('Unauthorized')===-1`))throw Error('Reload lost the local session');
  // Refresh explicitly through the rendered page's own periodic refresh, without reading secrets.
  await new Promise(r=>setTimeout(r,5200));
  await waitFor(`document.querySelector('[data-thread]')!==null`);
  await js(`document.querySelector('[data-thread]').click()`);
  await waitFor(`document.querySelector('#draft-form')!==null`);
  await new Promise(r=>setTimeout(r,300));
  writeFileSync(path.join(out,'windows-fixture.png'),(await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('#draft-form textarea').value='UIテストの返信案';document.querySelector('#draft-form').requestSubmit()`);
  await waitFor(`document.querySelector('#notice').innerText.includes('保存しました')`);
  if(vault.state.drafts.length!==1)throw Error('Draft staging failed');
  await js(`document.querySelector('[data-view="ai"]').click()`);
  if(await js(`document.querySelector('[data-grant]').checked`))throw Error('AI grant should default to off');
  if(errors.length)throw Error('Renderer console error');
  writeFileSync(path.join(out,'electron-result.json'),JSON.stringify({ok:true,fixture:true,osEncryption:true,checks:['empty inbox','connection dialog','account registration','fixture synchronization','thread rendering','draft staging','AI sharing defaults off','Slack browser login without token','Gmail presets and automatic name','reload preserves authentication'],rendererErrors:errors},null,2));
  console.log('Electron UI smoke passed: 10 checks; synthetic data; OS encryption round-trip passed.');
  win.destroy();await backend.close();app.quit();
 }catch(error){console.error(error.message);if(backend)await backend.close();app.exit(1);}
}).finally(()=>{try{rmSync(profile,{recursive:true});}catch{}});
