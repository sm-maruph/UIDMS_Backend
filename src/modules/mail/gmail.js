import {google} from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import {HttpError,requireCondition} from '../../core/errors.js';
import {z} from '../../core/validation.js';
import {googleTokenStore} from './google-token-store.js';
import {gmailConfig} from './google-config.js';
export const gmailScopes=['openid','email','https://www.googleapis.com/auth/gmail.send'];
export function safeGoogleFailure(error){
 const reason=error?.response?.data?.error;
 if(reason==='invalid_grant')return new HttpError(502,'GMAIL_REAUTHORIZE','Google authorization expired or was revoked. Authorize the UIDMS sender again.');
 if(reason==='redirect_uri_mismatch')return new HttpError(502,'GMAIL_REDIRECT_MISMATCH','GOOGLE_REDIRECT_URI must exactly match the redirect URI registered in Google Cloud.');
 if(reason==='invalid_client')return new HttpError(502,'GMAIL_CLIENT_INVALID','Google rejected the OAuth client. Check the client ID and secret privately.');
 const status=error?.response?.status;
 if(status===403)return new HttpError(502,'GMAIL_PERMISSION_DENIED','Google denied Gmail API access. Check the Gmail send scope and Workspace administrator API controls.');
 return new HttpError(502,status===429?'GMAIL_RATE_LIMITED':'GMAIL_CONNECTION_FAILED',status===429?'Google temporarily limited email sending. Wait before retrying.':'Google could not complete the request. Check outbound HTTPS/proxy access, certificate trust and Workspace API permissions.');
}
export function createGmail(config,dependencies={}){
 config={GMAIL_SETUP_ENABLED:false,GMAIL_SENDER_EMAIL:'itbangladesh@combankbd.com',GMAIL_SENDER_NAME:'User ID Management System (UIDMS), Bangladesh',MAIL_PORTAL_URL:'https://uidms.combankbd.com',...config};
 const {store=googleTokenStore(config),oauthFactory=()=>new google.auth.OAuth2({clientId:config.GOOGLE_CLIENT_ID,clientSecret:config.GOOGLE_CLIENT_SECRET,redirectUri:config.GOOGLE_REDIRECT_URI,transporterOptions:{timeout:20000,retry:false}}),gmailFactory=auth=>google.gmail({version:'v1',auth})}=dependencies;
 const configured=gmailConfig(config);
 const ready=()=>requireCondition(configured.ready,503,'GMAIL_NOT_CONFIGURED','Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in the backend environment.');
 return {
  store,oauthFactory,
  async status(){let saved=null,storageError=false;try{saved=await store.read();}catch{storageError=true;}return {diagnosticsVersion:'gmail-diag-v1',diagnostics:{clientIdConfigured:Boolean(config.GOOGLE_CLIENT_ID),clientSecretConfigured:Boolean(config.GOOGLE_CLIENT_SECRET),redirectConfigured:Boolean(config.GOOGLE_REDIRECT_URI)},configured:configured.ready,setupEnabled:configured.setupEnabled,connected:Boolean(saved),storageError,sender:config.GMAIL_SENDER_EMAIL,senderName:config.GMAIL_SENDER_NAME,redirectUri:config.GOOGLE_REDIRECT_URI||null,testRecipient:config.GMAIL_TEST_TO||'',authorizedAt:saved?.authorizedAt||null,testedAt:saved?.testedAt||null,automatedDeliveryEnabled:Boolean(config.GMAIL_NOTIFICATIONS_ENABLED&&configured.ready&&saved?.testedAt),notificationsConfigured:Boolean(config.GMAIL_NOTIFICATIONS_ENABLED)};},
  async authorize({code,codeVerifier,nonce}){
   ready();const auth=oauthFactory();let tokens,payload;
   try{({tokens}=await auth.getToken({code,codeVerifier,redirect_uri:config.GOOGLE_REDIRECT_URI}));const verified=await auth.verifyIdToken({idToken:tokens.id_token,audience:config.GOOGLE_CLIENT_ID});payload=verified.getPayload();}catch(error){throw safeGoogleFailure(error);}
   requireCondition(payload?.email_verified===true&&payload.email?.toLowerCase()===config.GMAIL_SENDER_EMAIL.toLowerCase()&&payload.hd?.toLowerCase()===config.GMAIL_SENDER_EMAIL.split('@')[1].toLowerCase()&&payload.nonce===nonce,403,'GMAIL_ACCOUNT_MISMATCH','Authorize the official itbangladesh@combankbd.com Google Workspace account. No token was saved.');
   requireCondition(tokens.scope?.split(' ').includes('https://www.googleapis.com/auth/gmail.send'),403,'GMAIL_SCOPE_MISSING','Grant the requested Gmail send permission and try again.');
   requireCondition(tokens.refresh_token,409,'GMAIL_REFRESH_TOKEN_MISSING','Google did not return offline access. Authorize again with the consent prompt.');
   await store.write({email:payload.email.toLowerCase(),refreshToken:tokens.refresh_token,authorizedAt:new Date().toISOString(),testedAt:null});
  },
  async send({to,cc=[],subject,html,text,messageId}){
   ready();const recipients=[...to,...cc];
   requireCondition(to.length>0&&recipients.length<=40&&recipients.every(address=>z.email().max(254).safeParse(address).success&&config.MAIL_ALLOWED_DOMAINS.split(',').map(value=>value.trim().toLowerCase()).includes(address.split('@')[1].toLowerCase())),400,'MAIL_RECIPIENT_NOT_ALLOWED','Use recipients from the configured company email domains.');
   requireCondition(typeof subject==='string'&&subject.length>0&&subject.length<=300&&!/[\r\n\0]/.test(subject)&&typeof html==='string'&&html.length<=200000&&typeof text==='string'&&text.length<=200000&&(!messageId||/^<[a-zA-Z0-9._@-]+>$/.test(messageId)),400,'MAIL_CONTENT_INVALID');
   const saved=await store.read();requireCondition(saved,409,'GMAIL_NOT_AUTHORIZED','Authorize the official sender before sending a test email.');
   const auth=oauthFactory();auth.setCredentials({refresh_token:saved.refreshToken});
   // Starting with only a refresh token proves offline token renewal on the test.
   const mime=await new MailComposer({from:{name:config.GMAIL_SENDER_NAME,address:config.GMAIL_SENDER_EMAIL},to,cc,subject,html,text,messageId,disableFileAccess:true,disableUrlAccess:true}).compile().build();
   try{const response=await gmailFactory(auth).users.messages.send({userId:'me',requestBody:{raw:mime.toString('base64url')}},{timeout:20000,retry:false});requireCondition(typeof response.data.id==='string'&&response.data.id.length>0,502,'GMAIL_SEND_RESULT_UNKNOWN');return {messageId:response.data.id};}catch(error){throw safeGoogleFailure(error);}
  },
 };
}
