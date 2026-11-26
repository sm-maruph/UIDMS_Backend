import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import {token,digest,equal} from '../../core/crypto.js';
import {p} from '../../core/db.js';
import {parse,z} from '../../core/validation.js';
import {requireCondition,HttpError} from '../../core/errors.js';
import {roles,recentAuth} from '../auth/service.js';
import {audit} from '../audit/service.js';
import {gmailScopes} from './gmail.js';
import {uidmsEmail} from './html-template.js';

const setupCookie='uidms_google_setup';
const opaque=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export function googleRoutes(db,config,gmail){
 const admin=Router(),browser=Router(),states=new Map();let testing=false;
 const enabled=()=>requireCondition(config.GMAIL_SETUP_ENABLED,404,'NOT_FOUND');
 const validSession=async entry=>{
  const result=await db.query(`SELECT s.UserId FROM dbo.Sessions s JOIN dbo.Users u ON u.Id=s.UserId
   WHERE s.TokenHash=@session AND s.UserId=@user AND s.RevokedAt IS NULL AND u.Active=1
    AND s.ExpiresAt>SYSUTCDATETIME() AND s.LastSeenAt>DATEADD(minute,-@idle,SYSUTCDATETIME())
    AND EXISTS(SELECT 1 FROM dbo.uidms_EffectiveRoles(s.UserId) er WHERE er.Role='Super Admin')`,{session:p.str(entry.session,64),user:p.id(entry.user.Id),idle:p.int(config.SESSION_IDLE_MINUTES)});
  requireCondition(result.recordset.length,403,'GMAIL_SETUP_SESSION_EXPIRED','Sign in as Super Admin again and restart Google authorization.');
 };
 const findState=state=>{const entry=states.get(digest(state));requireCondition(entry&&entry.expires>Date.now(),400,'GMAIL_STATE_INVALID','This Google setup link expired or was already used. Start authorization again.');return entry;};
 const cookieOptions=()=>({httpOnly:true,secure:new URL(config.GOOGLE_REDIRECT_URI).protocol==='https:',sameSite:'lax',path:'/auth/google',maxAge:10*60*1000});
 const returnOrigin=(config.NODE_ENV==='development'?config.origins?.find(origin=>['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)):null)||config.MAIL_PORTAL_URL;
 const page=(res,status,title,message)=>res.status(status).type('html').send(`<!doctype html><html><head><meta charset="UTF-8"><title>UIDMS Gmail setup</title></head><body><h1>${title}</h1><p>${message}</p><p><a href="${returnOrigin}/admin/settings">Return to UIDMS Admin settings</a> and refresh Gmail connection status.</p></body></html>`);
 const diagnostic=(event,req,fields={})=>{if(config.GMAIL_SETUP_ENABLED||event==='gmail.setup.configuration')console.info(JSON.stringify({event,diagnosticsVersion:'gmail-diag-v1',requestId:req.id,...fields}));};
 admin.use('/admin/gmail/authorize',(req,res,next)=>{diagnostic('gmail.setup.authorize_received',req,{method:req.method,environment:config.NODE_ENV,processId:process.pid,workingDirectory:process.cwd(),recentSignIn:Boolean(req.user?.AuthenticatedAt&&Date.now()-new Date(req.user.AuthenticatedAt).getTime()<10*60*1000)});res.once('finish',()=>diagnostic('gmail.setup.authorize_finished',req,{httpStatus:res.statusCode}));next();});
 admin.use('/admin/gmail',roles('Super Admin'));
 admin.get('/admin/gmail/status',async(req,res)=>{const status=await gmail.status();diagnostic('gmail.setup.configuration',req,{configured:status.configured,setupEnabled:status.setupEnabled,clientIdLoaded:status.diagnostics?.clientIdConfigured,clientSecretLoaded:status.diagnostics?.clientSecretConfigured,redirectUriLoaded:status.diagnostics?.redirectConfigured});res.json(status);});
 admin.post('/admin/gmail/authorize',recentAuth,async(req,res)=>{
  enabled();const status=await gmail.status();requireCondition(status.configured,503,'GMAIL_NOT_CONFIGURED','Set the Google client ID, secret and redirect URI in the backend environment, then restart the API.');
  for(const [key,entry] of states)if(entry.expires<=Date.now())states.delete(key);
  requireCondition(states.size<100,429,'GMAIL_SETUP_BUSY');
  const state=token(),nonce=token(),auth=gmail.oauthFactory(),pkce=await auth.generateCodeVerifierAsync();
  const authorizationUrl=auth.generateAuthUrl({access_type:'offline',prompt:'consent',scope:gmailScopes,include_granted_scopes:false,login_hint:config.GMAIL_SENDER_EMAIL,state,nonce,code_challenge:pkce.codeChallenge,code_challenge_method:'S256'});
  states.set(digest(state),{user:req.user,session:req.sessionHash,auditSessionId:req.auditSessionId,expires:Date.now()+10*60*1000,authorizationUrl,nonce,codeVerifier:pkce.codeVerifier,started:false});
  await audit(db.query,req,'gmail.authorization_started',null,{sender:config.GMAIL_SENDER_EMAIL});
  const start=new URL('/auth/google/start',config.GOOGLE_REDIRECT_URI);start.searchParams.set('state',state);res.json({authorizationUrl:start.href});
 });
 browser.use('/auth/google',rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}));
 browser.get('/auth/google/start',async(req,res)=>{
  enabled();const {state}=parse(z.object({state:opaque}).strict(),req.query),entry=findState(state);
  requireCondition(!entry.started,400,'GMAIL_STATE_INVALID','This setup link was already opened. Start again in Admin settings.');
  await validSession(entry);entry.started=true;entry.browser=digest(token());
  diagnostic('gmail.setup.google_redirect',req,{sessionValidated:true});res.cookie(setupCookie,entry.browser,cookieOptions());res.redirect(302,entry.authorizationUrl);
 });
 browser.get('/auth/google/callback',async(req,res)=>{
  enabled();const input=parse(z.object({state:opaque,code:z.string().min(1).max(4096).optional(),error:z.string().max(200).optional(),scope:z.string().max(2000).optional(),authuser:z.string().max(20).optional(),prompt:z.string().max(100).optional(),hd:z.string().max(253).optional()}).strict(),req.query);
  const entry=findState(input.state);states.delete(digest(input.state));
  requireCondition(entry.started&&typeof req.cookies?.[setupCookie]==='string'&&equal(req.cookies[setupCookie],entry.browser),400,'GMAIL_STATE_INVALID','Google authorization must finish in the browser that opened the setup link.');
  const {maxAge,...clearOptions}=cookieOptions();res.clearCookie(setupCookie,clearOptions);await validSession(entry);
  if(input.error)return page(res,400,'Google authorization was not completed','No refresh token was saved. Start again and allow the requested permissions.');
  requireCondition(input.code,400,'GMAIL_CODE_MISSING');requireCondition(!testing,409,'GMAIL_TEST_IN_PROGRESS');
  const actor={...req,user:entry.user,auditSessionId:entry.auditSessionId};
  try{await gmail.authorize({code:input.code,codeVerifier:entry.codeVerifier,nonce:entry.nonce});}
  catch(error){await audit(db.query,actor,'gmail.authorization_failed',null,{code:error instanceof HttpError?error.code:'GMAIL_SETUP_FAILED'});throw error;}
  await audit(db.query,actor,'gmail.authorization_completed',null,{sender:config.GMAIL_SENDER_EMAIL});
  res.redirect(303,'/auth/google/result');
 });
 browser.get('/auth/google/result',(req,res)=>{enabled();return page(res,200,'Google authorization completed','The sender refresh token was saved encrypted. Return to Admin settings and send the connection test. Automated notifications have not been enabled.');});
 admin.post('/admin/gmail/test',recentAuth,async(req,res)=>{
  enabled();const body=parse(z.object({testId:z.uuid(),to:z.email().max(254).optional()}).strict(),req.body);
  requireCondition(!testing,409,'GMAIL_TEST_IN_PROGRESS','A test email is already being processed.');testing=true;
  try{
   let saved=await gmail.store.read();requireCondition(saved,409,'GMAIL_NOT_AUTHORIZED','Authorize the official sender first.');
   const to=body.to||config.GMAIL_TEST_TO;requireCondition(to,400,'GMAIL_TEST_RECIPIENT_REQUIRED');
   const history=saved.testHistory|| (saved.lastTest?[saved.lastTest]:[]),previous=history.find(attempt=>attempt.id===body.testId);
   if(previous){requireCondition(previous.recipient===to,409,'GMAIL_TEST_ID_REUSED','This test ID belongs to another recipient. Start a new test.');requireCondition(previous.status==='accepted',409,'GMAIL_TEST_RESULT_UNKNOWN','This test was already attempted. Check the recipient mailbox before starting a new test.');return res.json({accepted:true,messageId:previous.messageId,testedAt:previous.at});}
   requireCondition(history.length<1000,409,'GMAIL_TEST_LIMIT','Review the Gmail setup history before starting more tests.');
   // Validate before writing an attempt record or contacting Google.
   requireCondition(z.email().safeParse(to).success&&config.MAIL_ALLOWED_DOMAINS.split(',').map(value=>value.trim().toLowerCase()).includes(to.split('@')[1].toLowerCase()),400,'MAIL_RECIPIENT_NOT_ALLOWED');
   const messageId=`<uidms-gmail-test-${body.testId}@${config.GMAIL_SENDER_EMAIL.split('@')[1]}>`;
   const content=uidmsEmail({heading:'UIDMS Gmail connection test',reference:'GMAIL-CONNECTION-TEST',requestType:'Email integration verification',status:'Test only',action:'This is the manually requested UIDMS test email. No ticket action is required.',details:'This test verifies OAuth offline access and Gmail API delivery. Automated notification triggers are not enabled yet.',requestUrl:config.MAIL_PORTAL_URL});
   await audit(db.query,req,'gmail.test_started',body.testId,{recipient:to});
   saved={...saved,lastTest:{id:body.testId,status:'pending',recipient:to,at:new Date().toISOString()}};saved.testHistory=[...history,saved.lastTest];await gmail.store.write(saved);
   let result;
   try{result=await gmail.send({to:[to],subject:'[UIDMS] Gmail API connection test',...content,messageId});}
   catch(error){const lastTest={...saved.lastTest,status:'unknown'};await gmail.store.write({...saved,lastTest,testHistory:saved.testHistory.map(attempt=>attempt.id===body.testId?lastTest:attempt)});await audit(db.query,req,'gmail.test_failed',body.testId,{code:error instanceof HttpError?error.code:'GMAIL_TEST_FAILED'});throw error;}
   const testedAt=new Date().toISOString(),lastTest={...saved.lastTest,status:'accepted',messageId:result.messageId};await gmail.store.write({...saved,testedAt,lastTest,testHistory:saved.testHistory.map(attempt=>attempt.id===body.testId?lastTest:attempt)});
   await audit(db.query,req,'gmail.test_accepted',body.testId,{messageId:result.messageId,recipient:to});
   res.json({accepted:true,messageId:result.messageId,testedAt});
  }finally{testing=false;}
 });
 return {admin,browser};
}
