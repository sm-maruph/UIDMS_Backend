import {z} from 'zod';
import {isIP} from 'node:net';
const bool=z.enum(['true','false']).transform(value=>value==='true');
export function readConfig(env=process.env){
 const schema=z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'),HOST:z.string().default('127.0.0.1'),PORT:z.coerce.number().int().min(1).max(65535).default(4000),
  ALLOWED_ORIGINS:z.string().min(1),TRUST_PROXY:z.string().default('false'),
  DB_SERVER:z.string().min(1),DB_PORT:z.coerce.number().int().min(1).max(65535).default(1433),DB_NAME:z.string().default('CBC_UIDMS'),DB_USER:z.string().min(1),DB_PASSWORD:z.string().min(12),
  DB_ENCRYPT:bool.default(true),DB_TRUST_CERTIFICATE:bool.default(false),DATA_ENCRYPTION_KEY:z.string().refine(value=>/^[A-Za-z0-9+/]{43}=$/.test(value)&&Buffer.from(value,'base64').length===32,'Expected a 32-byte base64 key'),
  SESSION_IDLE_MINUTES:z.coerce.number().int().min(5).max(30).default(30),SESSION_MAX_MINUTES:z.coerce.number().int().min(15).max(720).default(30),SESSION_MAX_HOURS:z.coerce.number().int().min(1).max(12).default(8),
  COOKIE_SECURE:bool.default(true),MFA_REQUIRED:bool.default(true),MOCK_LOGIN_ENABLED:bool.default(false),
  AUTH_MODE:z.enum(['local','hybrid','ad']).default('local'),LDAP_ENABLED:bool.optional(),
  LDAP_HOST:z.string().trim().max(253).default(''),LDAP_PORT:z.coerce.number().int().min(1).max(65535).default(389),
  LDAP_BASE_DN:z.string().trim().max(1000).default(''),LDAP_USERNAME:z.string().trim().max(1000).default(''),LDAP_PASSWORD:z.string().max(1024).default(''),
  LDAP_TIMEOUT:z.coerce.number().int().min(1000).max(60000).default(30000),LDAP_SSL:bool.default(false),LDAP_TLS:bool.optional(),
  LDAP_CA_FILE:z.string().max(1000).default(''),LDAP_TLS_SERVER_NAME:z.string().trim().max(253).default(''),
  LDAP_DIRECTORY_ID:z.string().regex(/^[a-z0-9_-]{1,40}$/).default('primary-ad'),LDAP_NETBIOS_DOMAIN:z.string().regex(/^[A-Za-z0-9_-]{0,30}$/).default(''),
  LDAP_UPN_SUFFIX:z.string().trim().max(253).default(''),LDAP_EMPLOYEE_ID_ATTRIBUTE:z.enum(['sAMAccountName','employeeID','employeeNumber']).default('sAMAccountName'),
  LDAP_ALLOW_INSECURE_LOCAL:bool.default(false),
  SMTP_HOST:z.string().default(''),SMTP_PORT:z.coerce.number().int().default(587),SMTP_SECURE:bool.default(false),SMTP_USER:z.string().default(''),SMTP_PASSWORD:z.string().default(''),MAIL_FROM:z.email().default('uidms@combankbd.com'),MAIL_ALLOWED_DOMAINS:z.string().default('combankbd.com')
 });
 const result=schema.safeParse(env);
 if(!result.success)throw new Error(`Invalid configuration: ${result.error.issues.map(item=>item.path.join('.')).join(', ')}`);
 const c=result.data;
 // The ordinary LDAP settings are enough; these overrides remain optional for older deployments.
 c.LDAP_ENABLED??=c.AUTH_MODE!=='local'&&Boolean(c.LDAP_HOST&&c.LDAP_BASE_DN&&c.LDAP_USERNAME&&c.LDAP_PASSWORD);
 c.LDAP_TLS??=!c.LDAP_SSL;
 if(env.LDAP_PORT===undefined)c.LDAP_PORT=c.LDAP_SSL?636:389;
 const baseDomain=[...c.LDAP_BASE_DN.matchAll(/(?:^|,)\s*dc=([A-Za-z0-9-]+)\s*(?=,|$)/gi)].map(match=>match[1]).join('.');
 c.LDAP_UPN_SUFFIX ||= /^[^\s@<>\[\]]+@([^\s@<>\[\]]+)$/.exec(c.LDAP_USERNAME)?.[1]||baseDomain;
 c.LDAP_NETBIOS_DOMAIN ||= baseDomain.split('.')[0]?.toUpperCase()||'';
 const hostname=value=>Boolean(isIP(value))||(!/^[\d.]+$/.test(value)&&value.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)));
 if(c.AUTH_MODE==='ad'&&!c.LDAP_ENABLED)throw new Error('AD-only login requires LDAP_HOST, LDAP_BASE_DN, LDAP_USERNAME and LDAP_PASSWORD; remove an explicit LDAP_ENABLED=false override.');
 if(c.LDAP_ENABLED){
  if(c.AUTH_MODE==='local')throw new Error('Enabled LDAP requires AUTH_MODE=hybrid or ad.');
  if(!hostname(c.LDAP_HOST)||c.LDAP_TLS_SERVER_NAME&&!hostname(c.LDAP_TLS_SERVER_NAME)||c.LDAP_UPN_SUFFIX&&!hostname(c.LDAP_UPN_SUFFIX))throw new Error('LDAP_HOST, LDAP_TLS_SERVER_NAME and LDAP_UPN_SUFFIX must be valid host/domain names without URLs or Markdown.');
  if(!c.LDAP_BASE_DN||!c.LDAP_USERNAME||!c.LDAP_PASSWORD||c.LDAP_PASSWORD.startsWith('REPLACE')||/[\r\n\0]/.test(c.LDAP_USERNAME))throw new Error('Set real LDAP_BASE_DN, LDAP_USERNAME and LDAP_PASSWORD in the backend environment.');
  if(/[\r\n\0]/.test(c.LDAP_BASE_DN)||!/^\s*[A-Za-z][A-Za-z0-9-]*=.+/.test(c.LDAP_BASE_DN))throw new Error('LDAP_BASE_DN must be a distinguished name without URLs or Markdown.');
  if(c.LDAP_SSL&&c.LDAP_TLS)throw new Error('Choose LDAPS (LDAP_SSL=true) or StartTLS (LDAP_TLS=true), not both.');
  const explicitPlaintext=env.LDAP_SSL==='false'&&env.LDAP_TLS==='false';
  if(!c.LDAP_SSL&&!c.LDAP_TLS&&!((explicitPlaintext||c.LDAP_ALLOW_INSECURE_LOCAL)&&c.NODE_ENV==='development'&&['127.0.0.1','localhost','::1'].includes(c.HOST)))throw new Error('LDAP simple bind requires LDAPS or StartTLS outside explicit local-development plaintext configuration.');
  if(c.NODE_ENV==='production'&&c.LDAP_ALLOW_INSECURE_LOCAL)throw new Error('Production forbids LDAP_ALLOW_INSECURE_LOCAL.');
  if(/(?:ldapts|\*)/i.test(env.NODE_DEBUG||''))throw new Error('Disable LDAP protocol debug logging before accepting directory passwords.');
 }
 if(c.MOCK_LOGIN_ENABLED&&(c.NODE_ENV!=='development'||!['127.0.0.1','localhost','::1'].includes(c.HOST)||!['127.0.0.1','localhost','::1'].includes(c.DB_SERVER)))throw new Error('Mock login is allowed only in local development with a local database.');
 c.origins=c.ALLOWED_ORIGINS.split(',').map(value=>value.trim());
 if(c.origins.some(origin=>{try{return new URL(origin).origin!==origin;}catch{return true;}}))throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins');
 if(c.origins.some(origin=>!/^https?:\/\//.test(origin)))throw new Error('HTTP(S) origins required');
 if(c.TRUST_PROXY==='true'||c.TRUST_PROXY==='*')throw new Error('Set TRUST_PROXY to false or an explicit proxy IP/CIDR');
 if(c.DATA_ENCRYPTION_KEY.startsWith('REPLACE')||c.DB_PASSWORD.startsWith('REPLACE'))throw new Error('Replace configuration placeholders');
 if(c.NODE_ENV==='production'&&(!c.COOKIE_SECURE||!c.DB_ENCRYPT||c.DB_TRUST_CERTIFICATE||!c.MFA_REQUIRED||c.origins.some(origin=>!origin.startsWith('https://'))))throw new Error('Production requires TLS, certificate verification, secure cookies, MFA and HTTPS origins');
 return c;
}
