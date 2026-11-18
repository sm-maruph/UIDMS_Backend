import {z} from 'zod';
const bool=z.enum(['true','false']).transform(value=>value==='true');
export function readConfig(env=process.env){
 const schema=z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'),HOST:z.string().default('127.0.0.1'),PORT:z.coerce.number().int().min(1).max(65535).default(4000),
  ALLOWED_ORIGINS:z.string().min(1),TRUST_PROXY:z.string().default('false'),
  DB_SERVER:z.string().min(1),DB_PORT:z.coerce.number().int().min(1).max(65535).default(1433),DB_NAME:z.string().default('CBC_UIDMS'),DB_USER:z.string().min(1),DB_PASSWORD:z.string().min(16),
  DB_ENCRYPT:bool.default(true),DB_TRUST_CERTIFICATE:bool.default(false),DATA_ENCRYPTION_KEY:z.string().refine(value=>/^[A-Za-z0-9+/]{43}=$/.test(value)&&Buffer.from(value,'base64').length===32,'Expected a 32-byte base64 key'),
  SESSION_IDLE_MINUTES:z.coerce.number().int().min(5).max(30).default(15),SESSION_MAX_HOURS:z.coerce.number().int().min(1).max(12).default(8),
  COOKIE_SECURE:bool.default(true),MFA_REQUIRED:bool.default(true),
  SMTP_HOST:z.string().default(''),SMTP_PORT:z.coerce.number().int().default(587),SMTP_SECURE:bool.default(false),SMTP_USER:z.string().default(''),SMTP_PASSWORD:z.string().default(''),MAIL_FROM:z.email().default('uidms@combankbd.com'),MAIL_ALLOWED_DOMAINS:z.string().default('combankbd.com')
 });
 const result=schema.safeParse(env);
 if(!result.success)throw new Error(`Invalid configuration: ${result.error.issues.map(item=>item.path.join('.')).join(', ')}`);
 const c=result.data;
 c.origins=c.ALLOWED_ORIGINS.split(',').map(value=>value.trim());
 if(c.origins.some(origin=>{try{return new URL(origin).origin!==origin;}catch{return true;}}))throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins');
 if(c.origins.some(origin=>!/^https?:\/\//.test(origin)))throw new Error('HTTP(S) origins required');
 if(c.TRUST_PROXY==='true'||c.TRUST_PROXY==='*')throw new Error('Set TRUST_PROXY to false or an explicit proxy IP/CIDR');
 if(c.DATA_ENCRYPTION_KEY.startsWith('REPLACE')||c.DB_PASSWORD.startsWith('REPLACE'))throw new Error('Replace configuration placeholders');
 if(c.NODE_ENV==='production'&&(!c.COOKIE_SECURE||!c.DB_ENCRYPT||c.DB_TRUST_CERTIFICATE||!c.MFA_REQUIRED||c.origins.some(origin=>!origin.startsWith('https://'))))throw new Error('Production requires TLS, certificate verification, secure cookies, MFA and HTTPS origins');
 return c;
}
