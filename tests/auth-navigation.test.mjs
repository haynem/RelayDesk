import test from 'node:test';
import assert from 'node:assert/strict';
import {allowAuthPopup,slackTokenFromBody,slackBrowserUrl} from '../dist/auth-navigation.js';
test('Slack workspace popups allow official HTTPS hosts and reject spoofing and local app execution',()=>{
  assert.equal(allowAuthPopup('slack','https://app.slack.com/client/T-FIXTURE'),true);
  assert.equal(allowAuthPopup('slack','https://fixture.slack.com/'),true);
  for(const url of ['https://slack.com.evil.test/','https://evilslack.com/','http://app.slack.com/','slack://open','file:///C:/fixture.exe','https://slack.com:8443/','https://attacker@slack.com/','javascript:alert(1)'])assert.equal(allowAuthPopup('slack',url),false,url);
  assert.equal(allowAuthPopup('messenger','https://app.slack.com/'),false);
});
test('Slack login recognizes form, JSON and multipart tokens without accepting arbitrary fields',()=>{
  const token='xoxc-synthetic-fixture';assert.equal(slackTokenFromBody('token='+token+'&other=fixture'),token);
  assert.equal(slackTokenFromBody(JSON.stringify({token})),token);
  assert.equal(slackTokenFromBody('--fixture\r\nContent-Disposition: form-data; name="token"\r\n\r\n'+token+'\r\n--fixture--'),token);
  assert.equal(slackTokenFromBody('--fixture\r\nContent-Disposition: form-data; name="message"\r\n\r\n'+token+'\r\n--fixture--'),undefined);
  assert.equal(slackTokenFromBody(JSON.stringify({token:'not-a-token'})),undefined);
  assert.equal(slackBrowserUrl('slack://open?team=T123&id=C123'),'https://app.slack.com/client/T123/C123');
  assert.equal(slackBrowserUrl('slack://open?team=evil.test'),undefined);
});
