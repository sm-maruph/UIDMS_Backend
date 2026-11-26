import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationEmail,deliverNotificationBatch} from '../src/modules/mail/notification-worker.js';
import {notify} from '../src/modules/audit/service.js';
import {actorId,requestId} from './helpers.js';
const config={GMAIL_NOTIFICATIONS_ENABLED:true,MAIL_PORTAL_URL:'https://uidms.combankbd.com',GMAIL_SENDER_EMAIL:'itbangladesh@combankbd.com'};
const body={format:'uidms-notification-v1',recipientUserId:actorId,requestId,reference:'UID-2026-12',requestType:'New AD request',requesterName:'A <script>alert(1)</script>',requesterEmployeeId:'BD123',branch:'Head Office BD',department:'IT',actionType:'grant, revoke',status:'In review',action:'Recommendation required.'};
function fixture({failure,missingRecipient=false,tested=true}={}){
 const calls=[],sent=[],logs=[];let queued=true;
 const db={transaction:async work=>work(async sql=>{calls.push({sql});if(!queued)return {recordset:[]};queued=false;return {recordset:[{QueueId:'9007199254740993',Body:JSON.stringify(body)}]};}),query:async(sql,params)=>{calls.push({sql,params});return {recordset:sql.startsWith('SELECT')&&!missingRecipient?[{Email:'current-profile@combankbd.com'}]:[]};}};
 const gmail={status:async()=>({configured:true,connected:true,testedAt:tested?'2026-11-26':null}),send:async value=>{sent.push(value);if(failure)throw {code:failure};return {messageId:'google-accepted-id'};}};
 return {db,gmail,calls,sent,logs,options:{log:value=>logs.push(value)}};
}
test('request email includes minimal escaped summary, action types and a direct ticket link',()=>{
 const email=notificationEmail(JSON.stringify(body),config.MAIL_PORTAL_URL);
 for(const value of ['Request Type','Request Action Type','Requester name','Grant access, Remove access','Head Office BD','BD123'])assert.ok(email.html.includes(value));
 assert.ok(email.html.includes('&lt;script&gt;'));assert.ok(!email.html.includes('<script>'));
 assert.ok(email.html.includes('https://uidms.combankbd.com/requests/UID-2026-12'));
 for(const invalid of [{...body,format:'old'},{...body,requestId:'../bad'}])assert.throws(()=>notificationEmail(JSON.stringify(invalid),config.MAIL_PORTAL_URL));
});
test('notification outbox uses authoritative request/profile metadata in the request transaction',async()=>{
 let query;await notify(async(sql,params)=>{query={sql,params};},actorId,requestId,'Approval required');
 assert.ok(query.sql.includes('uidms-notification-v1'));assert.ok(query.sql.includes('INSERT dbo.Notifications'));assert.ok(query.sql.includes('u.Active=1'));assert.ok(query.sql.includes('r.DeletedAt IS NULL'));assert.equal(query.params.user.value,actorId);
});
test('worker requires the live test and explicit enable flag before claiming mail',async()=>{
 const f=fixture({tested:false});assert.equal(await deliverNotificationBatch(f.db,{...config,GMAIL_NOTIFICATIONS_ENABLED:false},f.gmail),0);
 await assert.rejects(deliverNotificationBatch(f.db,config,f.gmail),/GMAIL_LIVE_TEST_REQUIRED/);assert.equal(f.calls.length,0);
});
test('worker leases new notification records only, resolves current email and persists acceptance',async()=>{
 const f=fixture();assert.equal(await deliverNotificationBatch(f.db,config,f.gmail,f.options),1);
 assert.ok(f.calls[0].sql.includes('UPDLOCK,ROWLOCK'));assert.ok(f.calls[0].sql.includes('uidms-notification-v1'));
 assert.deepEqual(f.sent[0].to,['current-profile@combankbd.com']);assert.equal(f.sent[0].messageId,'<uidms-outbox-9007199254740993@combankbd.com>');
 assert.ok(f.calls.some(call=>call.sql.includes('SET SentAt=SYSUTCDATETIME()')));assert.equal(f.logs[0].messageId,'google-accepted-id');
 assert.ok(!JSON.stringify(f.logs).includes('current-profile'));
});
test('missing active profile holds mail; rate limits retry; uncertain sends are not retried automatically',async()=>{
 for(const options of [{missingRecipient:true},{failure:'GMAIL_RATE_LIMITED'},{failure:'GMAIL_CONNECTION_FAILED'}]){
  const f=fixture(options);assert.equal(await deliverNotificationBatch(f.db,config,f.gmail,f.options),0);
  const update=f.calls.find(call=>call.sql.includes('LastError=@error'));
  assert.equal(Boolean(update.params.retry.value),options.failure==='GMAIL_RATE_LIMITED');
  if(options.missingRecipient)assert.equal(f.sent.length,0);
 }
});
