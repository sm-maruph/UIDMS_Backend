import {z} from '../../core/validation.js';
export function gmailConfig(config){
 const ready=Boolean(config.GOOGLE_CLIENT_ID&&config.GOOGLE_CLIENT_SECRET&&config.GOOGLE_REDIRECT_URI&&![config.GOOGLE_CLIENT_ID,config.GOOGLE_CLIENT_SECRET].some(value=>value.startsWith('REPLACE')));
 if(config.GOOGLE_REDIRECT_URI){
  const uri=new URL(config.GOOGLE_REDIRECT_URI);
  if(uri.pathname!=='/auth/google/callback'||uri.search||uri.hash||uri.username||uri.password||!(uri.protocol==='https:'||(config.NODE_ENV!=='production'&&uri.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(uri.hostname))))throw new Error('GOOGLE_REDIRECT_URI must use HTTPS (or local development HTTP) and /auth/google/callback.');
 }
 for(const key of ['GMAIL_SENDER_EMAIL','GMAIL_TEST_TO'])if(config[key]&&!z.email().safeParse(config[key]).success)throw new Error('Invalid '+key);
 const portal=new URL(config.MAIL_PORTAL_URL);
 if(portal.origin!==config.MAIL_PORTAL_URL||!(portal.protocol==='https:'||(config.NODE_ENV!=='production'&&portal.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(portal.hostname))))throw new Error('MAIL_PORTAL_URL must be an HTTPS origin or local development origin.');
 return {ready,setupEnabled:Boolean(config.GMAIL_SETUP_ENABLED)};
}
