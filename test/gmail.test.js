import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import cookieParser from 'cookie-parser';import request from 'supertest';import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';import {resolve,join} from 'node:path';
import {createGmail,gmailScopes,safeGoogleFailure} from '../src/modules/mail/gmail.js';import {googleTokenStore} from '../src/modules/mail/google-token-store.js';import {googleRoutes} from '../src/modules/mail/google-routes.js';import {gmailConfig} from '../src/modules/mail/google-config.js';import {uidmsEmail} from '../src/modules/mail/html-template.js';import {errorHandler} from '../src/core/errors.js';import {testConfig,user,actorId} from './helpers.js';

const config={...testConfig,GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-client-secret',GOOGLE_REDIRECT_URI:'http://127.0.0.1:4000/auth/google/callback',GMAIL_SETUP_ENABLED:true,GMAIL_SENDER_EMAIL:'itbangladesh@combankbd.com',GMAIL_SENDER_NAME:'User ID Management System (UIDMS), Bangladesh',GMAIL_TEST_TO:'alnoorshah@combankbd.com',MAIL_PORTAL_URL:'https://uidms.combankbd.com'};
function fixture(options={}){
 let stored=options.saved||null,authOptions,role='Super Admin';const calls=[],sent=[];
 const store={read:async()=>stored,write:async value=>{stored=structuredClone(value);}};
 const oauth={generateCodeVerifierAsync:async()=>({codeVerifier:'fixture-pkce',codeChallenge:'fixture-challenge'}),generateAuthUrl:params=>{authOptions=params;return 'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({...params,scope:params.scope.join(' ')});},getToken:async params=>{calls.push({tokenRequest:params});return {tokens:{refresh_token:'fixture-refresh-token',id_token:'fixture-id-token',scope:gmailScopes.join(' '),...options.tokens}};},verifyIdToken:async params=>{calls.push({verify:params});return {getPayload:()=>({email:config.GMAIL_SENDER_EMAIL,email_verified:true,hd:'combankbd.com',nonce:authOptions.nonce,...options.identity})};},setCredentials:value=>calls.push({credentials:value})};
 const service=createGmail(config,{store,oauthFactory:()=>oauth,gmailFactory:auth=>({users:{messages:{send:async(params,requestOptions)=>{sent.push({params,requestOptions});if(options.sendError)throw options.sendError;return {data:{id:'fixture-message-id'}};}}}})});
 const db={query:async(text,params)=>{calls.push({text,params});return {recordset:options.expiredSession?[]:[{UserId:actorId}]};}};
 const routes=googleRoutes(db,{...config,...options.config},service),app=express();app.use(cookieParser());app.use(express.json());app.use((req,res,next)=>{req.user={...user,Role:role,AuthenticatedAt:new Date()};req.id=actorId;req.sessionHash='fixture-session-hash';next();});app.use('/api',routes.admin);app.use(routes.browser);app.use(errorHandler);
 return {app,service,store,calls,sent,getSaved:()=>stored,setRole:value=>role=value,getAuthOptions:()=>authOptions};
}
async function begin(f){const response=await request(f.app).post('/api/admin/gmail/authorize').send({});assert.equal(response.status,200);const url=new URL(response.body.authorizationUrl),start=await request(f.app).get(url.pathname+url.search);assert.equal(start.status,302);return {state:url.searchParams.get('state'),cookie:start.headers['set-cookie'][0].split(';')[0]};}

test('Google sender setup uses offline consent, PKCE, verified identity and one-use browser-bound state',async()=>{
 const f=fixture(),flow=await begin(f),options=f.getAuthOptions();assert.equal(options.access_type,'offline');assert.equal(options.prompt,'consent');assert.equal(options.code_challenge_method,'S256');assert.equal(options.login_hint,config.GMAIL_SENDER_EMAIL);assert.ok(options.scope.includes('openid'));assert.ok(!options.scope.includes('https://www.googleapis.com/auth/gmail.readonly'));
 const response=await request(f.app).get('/auth/google/callback').query({state:flow.state,code:'fixture-code'}).set('Cookie',flow.cookie);assert.equal(response.status,303);assert.equal(f.getSaved().refreshToken,'fixture-refresh-token');assert.ok(f.calls.some(call=>call.tokenRequest?.codeVerifier==='fixture-pkce'));
 assert.equal((await request(f.app).get('/auth/google/callback').query({state:flow.state,code:'fixture-code'}).set('Cookie',flow.cookie)).status,400);
 const status=await request(f.app).get('/api/admin/gmail/status');assert.equal(status.status,200);assert.equal(status.body.connected,true);assert.equal(JSON.stringify(status.body).includes('fixture-refresh-token'),false);assert.equal(status.body.automatedDeliveryEnabled,false);
});
test('callback accepts Google issuer metadata and rejects other issuers before exchanging tokens',async()=>{
 for(const iss of ['https://accounts.google.com','accounts.google.com']){
  const f=fixture(),flow=await begin(f);
  const response=await request(f.app).get('/auth/google/callback').query({state:flow.state,code:'fixture-code',iss}).set('Cookie',flow.cookie);
  assert.equal(response.status,303);assert.ok(f.getSaved()?.refreshToken);
 }
 const f=fixture(),flow=await begin(f);
 const response=await request(f.app).get('/auth/google/callback').query({state:flow.state,code:'fixture-code',iss:'https://other.example'}).set('Cookie',flow.cookie);
 assert.equal(response.status,400);assert.equal(f.getSaved(),null);assert.equal(f.calls.some(call=>call.tokenRequest),false);
});

test('unknown states, missing browser cookie, wrong Workspace identity and wrong nonce never save tokens',async()=>{
 for(const identity of [{email:'wrong@combankbd.com'},{email_verified:false},{hd:'other.example'},{nonce:'wrong'}]){const f=fixture({identity}),flow=await begin(f);const response=await request(f.app).get('/auth/google/callback').query({state:flow.state,code:'fixture-code'}).set('Cookie',flow.cookie);assert.equal(response.status,403);assert.equal(f.getSaved(),null);}
 const f=fixture(),flow=await begin(f);assert.equal((await request(f.app).get('/auth/google/callback').query({state:flow.state,code:'fixture-code'})).status,400);assert.equal(f.getSaved(),null);
 assert.equal((await request(f.app).get('/auth/google/start').query({state:'x'.repeat(43)})).status,400);
});
test('only Super Admin can configure sender/test email; disabled setup and expired sessions fail closed',async()=>{
 for(const role of ['User','IT','Admin','CITO']){const f=fixture();f.setRole(role);assert.equal((await request(f.app).post('/api/admin/gmail/authorize').send({})).status,403);assert.equal(f.calls.length,0);}
 const disabled=fixture({config:{GMAIL_SETUP_ENABLED:false}});assert.equal((await request(disabled.app).post('/api/admin/gmail/authorize').send({})).status,404);
 const expired=fixture({expiredSession:true});const response=await request(expired.app).post('/api/admin/gmail/authorize').send({});const url=new URL(response.body.authorizationUrl);assert.equal((await request(expired.app).get(url.pathname+url.search)).status,403);
});
test('Gmail test sends MIME through gmail.send using only stored refresh credentials, then deduplicates the test ID',async()=>{
 const f=fixture({saved:{email:config.GMAIL_SENDER_EMAIL,refreshToken:'fixture-refresh-token'}}),body={testId:'55555555-5555-4555-8555-555555555555',to:config.GMAIL_TEST_TO};
 const first=await request(f.app).post('/api/admin/gmail/test').send(body);assert.equal(first.status,200);assert.equal(first.body.accepted,true);assert.equal(f.sent.length,1);
 const mime=Buffer.from(f.sent[0].params.requestBody.raw,'base64url').toString();assert.ok(mime.includes('itbangladesh@combankbd.com'));assert.ok(mime.includes('alnoorshah@combankbd.com'));assert.ok(mime.includes('User ID Management System'));assert.equal(f.sent[0].requestOptions.retry,false);
 const credentials=f.calls.find(call=>call.credentials).credentials;assert.deepEqual(credentials,{refresh_token:'fixture-refresh-token'});assert.ok(f.getSaved().testedAt);
 assert.equal((await request(f.app).post('/api/admin/gmail/test').send(body)).status,200);assert.equal(f.sent.length,1);
 assert.equal((await request(f.app).post('/api/admin/gmail/test').send({...body,testId:'66666666-6666-4666-8666-666666666666',to:'outside@example.com'})).status,400);assert.equal(f.sent.length,1);
});
test('uncertain sends are not automatically retried and Google error payloads never expose credentials',async()=>{
 const rawError={response:{status:500,data:{error:'fixture-token-secret'}}},f=fixture({saved:{email:config.GMAIL_SENDER_EMAIL,refreshToken:'fixture-refresh-token'},sendError:rawError}),body={testId:'55555555-5555-4555-8555-555555555555'};
 const failed=await request(f.app).post('/api/admin/gmail/test').send(body);assert.equal(failed.status,502);assert.equal(failed.text.includes('fixture-token-secret'),false);assert.equal(f.getSaved().lastTest.status,'unknown');assert.equal((await request(f.app).post('/api/admin/gmail/test').send(body)).status,409);assert.equal(f.sent.length,1);
 assert.equal(safeGoogleFailure({response:{data:{error:'invalid_grant'}}}).code,'GMAIL_REAUTHORIZE');
});
test('refresh token storage is encrypted, survives restart and is bound to the configured key/account/client',async()=>{
 const root=resolve('tmp');await mkdir(root,{recursive:true});const folder=await mkdtemp(join(root,'gmail-test-')),file=join(folder,'token.json');
 try{const store=googleTokenStore(config,file);assert.equal(await store.read(),null);await store.write({email:config.GMAIL_SENDER_EMAIL,refreshToken:'fixture-refresh-secret'});assert.equal((await readFile(file,'utf8')).includes('fixture-refresh-secret'),false);assert.equal((await googleTokenStore(config,file).read()).refreshToken,'fixture-refresh-secret');await assert.rejects(googleTokenStore({...config,GOOGLE_CLIENT_ID:'wrong-client'},file).read());}
 finally{assert.ok(folder.startsWith(root));await rm(folder,{recursive:true,force:true});}
});
test('mail links and HTML values are safe, and production callback configuration requires HTTPS',()=>{
 const template=uidmsEmail({heading:'<script>bad</script>',reference:'UID-1',action:'Review',requestUrl:config.MAIL_PORTAL_URL});assert.equal(template.html.includes('<script>bad'),false);assert.ok(template.html.includes('&lt;script&gt;'));
 assert.throws(()=>uidmsEmail({requestUrl:'javascript:alert(1)'}));assert.throws(()=>gmailConfig({...config,NODE_ENV:'production'}));assert.equal(gmailConfig({...config,NODE_ENV:'production',GOOGLE_REDIRECT_URI:'https://uidms.combankbd.com/auth/google/callback'}).ready,true);
});

test('missing offline token or Gmail send scope cannot complete sender authorization',async()=>{
 for(const tokens of [{refresh_token:undefined},{scope:'openid email'}]){
  const f=fixture({tokens}),flow=await begin(f);const response=await request(f.app).get('/auth/google/callback').query({state:flow.state,code:'fixture-code'}).set('Cookie',flow.cookie);assert.ok([403,409].includes(response.status));assert.equal(f.getSaved(),null);
 }
});

test('setup diagnostics report loaded configuration flags and never expose Google secrets',async t=>{
 const logs=[];t.mock.method(console,'info',value=>logs.push(String(value)));
 const f=fixture(),status=await request(f.app).get('/api/admin/gmail/status');assert.equal(status.status,200);assert.equal(status.body.diagnostics.clientIdConfigured,true);assert.equal(status.body.diagnostics.clientSecretConfigured,true);
 await begin(f);const joined=logs.join('\n');assert.ok(joined.includes('gmail.setup.configuration'));assert.ok(joined.includes('gmail.setup.authorize_received'));assert.ok(joined.includes('gmail.setup.google_redirect'));
 for(const forbidden of ['fixture-client-secret','fixture-refresh-token','fixture-id-token','fixture-pkce','authorizationUrl'])assert.equal(joined.includes(forbidden),false);
 assert.equal(status.text.includes('fixture-client-secret'),false);
});
