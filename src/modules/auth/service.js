import {randomUUID} from 'node:crypto';
import {finalizeAuditSessions,closeAuditSessions} from '../audit/sessions.js';
import * as OTPAuth from 'otpauth';
import {p,sql} from '../../core/db.js';
import {token,digest,equal,hashPassword,verifyPassword,seal,unseal} from '../../core/crypto.js';
import {HttpError,requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';
import {mockLoginAllowed} from './mock-policy.js';
import {createLdapDirectory} from './ldap-directory.js';
import {providerEnabled} from './providers.js';
import {resolveAdProfile} from './ad-profile.js';
import {beginDirectoryEnrollment,createDirectoryOnboarding} from './directory-onboarding.js';
import {hydrateAuthority,hasRole} from './authorization.js';
import {mfaPausedForTesting,mfaRequiredForUser} from './mfa-policy.js';

export const publicUser=raw=>{const user=hydrateAuthority(raw);return {id:user.Id,employeeId:user.EmployeeId,name:user.Name,email:user.Email,role:user.Role,baseRole:user.BaseRole,roles:user.EffectiveRoles,managedScopes:user.ManagedScopes,branchId:user.BranchId,departmentId:user.DepartmentId,designationId:user.DesignationId,active:user.Active,isDemo:Boolean(user.IsDemo),canApproveRequests:Boolean(user.CanApproveRequests),canManageActing:Boolean(user.OwnedScopes||['IT','CITO'].includes(user.BaseRole)||hasRole(user,'IT','CITO','Admin','Super Admin')),version:user.Version?.toString('hex')};};
export const userColumns="u.Id,u.EmployeeId,u.Name,u.Email,u.Role,u.BranchId,u.DepartmentId,u.DesignationId,u.Active,u.IsDemo,u.Version,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.uidms_ManagedScopes(u.Id)) THEN 1 ELSE 0 END AS bit) AS CanApproveRequests,(SELECT COUNT(*) FROM dbo.OrganizationApprovers oa WHERE oa.UserId=u.Id) AS OwnedScopes,(SELECT Role FROM dbo.uidms_EffectiveRoles(u.Id) FOR JSON PATH) AS EffectiveRolesJson,(SELECT ScopeId,Role,Acting FROM dbo.uidms_ManagedScopes(u.Id) FOR JSON PATH) AS ManagedScopesJson";
export function createAuth(db,config,{directory=createLdapDirectory(config)}={}){
 const cookieName=config.COOKIE_SECURE?'__Host-uidms':'uidms_dev';
 const cookieOptions={httpOnly:true,secure:config.COOKIE_SECURE,sameSite:'strict',path:'/',maxAge:config.SESSION_MAX_HOURS*3600000};
 async function createSession(query,req,user,provider='local'){
  if(user.EffectiveRolesJson===undefined)user=(await query(`SELECT ${userColumns} FROM dbo.Users u WHERE u.Id=@id`,{id:p.id(user.Id)})).recordset[0]||user;
  user=hydrateAuthority(user);
  const raw=token(),csrf=token(),auditSessionId=randomUUID();
  await finalizeAuditSessions(query,config,user.Id);
  await closeAuditSessions(query,{userId:user.Id,reason:'replaced'});
  await query('UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@user AND RevokedAt IS NULL',{user:p.id(user.Id)});
  const sessionParams={audit:p.id(auditSessionId),user:p.id(user.Id),employee:p.text(user.EmployeeId,40),name:p.text(user.Name,160),role:p.text(user.Role,40),hours:p.int(config.SESSION_MAX_HOURS),idle:p.int(config.SESSION_IDLE_MINUTES),ip:p.str(req.ip,64),agent:p.text(String(req.get('user-agent')||'').slice(0,300),300),provider:p.str(provider,10)};
  await query('INSERT dbo.AuditSessions(Id,UserId,EmployeeId,Name,Role,AuthProvider,ExpiresAt,IdleMinutes,Ip,LastIp,UserAgent) VALUES(@audit,@user,@employee,@name,@role,@provider,DATEADD(hour,@hours,SYSUTCDATETIME()),@idle,@ip,@ip,@agent)',sessionParams);
  await query('INSERT dbo.Sessions(TokenHash,UserId,CsrfHash,CreatedAt,LastSeenAt,ExpiresAt,Ip,UserAgent,AuthProvider,AuditSessionId) SELECT @token,@user,@csrf,StartedAt,StartedAt,ExpiresAt,@ip,@agent,@provider,Id FROM dbo.AuditSessions WHERE Id=@audit',{...sessionParams,token:p.str(digest(raw),64),csrf:p.str(digest(csrf),64)});
  await audit(query,{...req,user,auditSessionId},'auth.login',user.Id,{provider,mfaPausedForTesting:mfaPausedForTesting(config)});
  return {raw,csrf,user:publicUser(user),provider};
 }
 function sendSession(res,result){res.cookie(cookieName,result.raw,cookieOptions);res.json({user:result.user,csrfToken:result.csrf,provider:result.provider});}
 async function authenticate(req,res,next){
  const raw=req.cookies?.[cookieName];
  requireCondition(typeof raw==='string'&&/^[\w-]{43}$/.test(raw),401,'UNAUTHENTICATED');
  const hash=digest(raw);
  const result=await db.query(`UPDATE dbo.Sessions SET LastSeenAt=SYSUTCDATETIME() OUTPUT inserted.TokenHash WHERE TokenHash=@hash AND RevokedAt IS NULL AND ExpiresAt>SYSUTCDATETIME() AND LastSeenAt>DATEADD(minute,-@idle,SYSUTCDATETIME()); UPDATE a SET LastSeenAt=s.LastSeenAt,LastIp=@ip,IdleMinutes=@idle FROM dbo.AuditSessions a JOIN dbo.Sessions s ON s.AuditSessionId=a.Id JOIN dbo.Users u ON u.Id=s.UserId WHERE s.TokenHash=@hash AND s.RevokedAt IS NULL AND s.ExpiresAt>SYSUTCDATETIME() AND s.LastSeenAt>DATEADD(minute,-@idle,SYSUTCDATETIME()) AND u.Active=1 AND a.EndedAt IS NULL; SELECT ${userColumns},s.CsrfHash,s.AuthProvider,s.AuditSessionId,s.CreatedAt AS AuthenticatedAt FROM dbo.Sessions s JOIN dbo.Users u ON u.Id=s.UserId WHERE s.TokenHash=@hash AND u.Active=1 AND s.RevokedAt IS NULL AND s.ExpiresAt>SYSUTCDATETIME() AND s.LastSeenAt>DATEADD(minute,-@idle,SYSUTCDATETIME())`,{hash:p.str(hash,64),idle:p.int(config.SESSION_IDLE_MINUTES),ip:p.str(req.ip,64)});
  requireCondition(result.recordsets[0]?.length&&result.recordsets[1]?.length,401,'SESSION_EXPIRED');
  req.user=hydrateAuthority(result.recordsets[1][0]);req.sessionHash=hash;req.auditSessionId=req.user.AuditSessionId||null;
  requireCondition(providerEnabled(config,req.user.AuthProvider||'local'),401,'AUTH_PROVIDER_DISABLED');
  requireCondition(!req.user.IsDemo||mockLoginAllowed(config,req,req.user),401,'DEMO_LOGIN_DISABLED');
  if(!['GET','HEAD','OPTIONS'].includes(req.method))requireCondition(equal(digest(String(req.get('x-csrf-token')||'')),req.user.CsrfHash),403,'CSRF_INVALID');
  next();
 }
 async function challenge(query,user,provider='local'){
  const raw=token();
  await query("DELETE dbo.AuthChallenges WHERE UserId=@user AND Purpose='mfa'; INSERT dbo.AuthChallenges(TokenHash,UserId,Purpose,ExpiresAt,AuthProvider) VALUES(@hash,@user,'mfa',DATEADD(minute,5,SYSUTCDATETIME()),@provider)",{user:p.id(user.Id),hash:p.str(digest(raw),64),provider:p.str(provider,10)});
  return {challenge:raw,mfaEnrollmentRequired:!user.MfaSecret,expiresInSeconds:300};
 }
 async function login(req,res){
  const provider=req.body.provider||(config.AUTH_MODE==='ad'?'ad':'local');
  requireCondition(providerEnabled(config,provider),503,'AUTH_PROVIDER_DISABLED','The selected sign-in method is not enabled.');
  if(provider==='ad')return loginWithAd(req,res);
  const {employeeId,password}=req.body;
  const found=(await db.query('SELECT TOP(1) * FROM dbo.Users WHERE EmployeeId=@employee',{employee:p.text(employeeId,40)})).recordset[0];
  const valid=await verifyPassword(password,found?.PasswordHash);
  const result=await db.transaction(async query=>{
   const user=found?(await query('SELECT * FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id',{id:p.id(found.Id)})).recordset[0]:null;
   if(!user||!user.Active||!valid||user.PasswordHash!==found.PasswordHash||(user.IsDemo&&!mockLoginAllowed(config,req,user))||(user.LockedUntil&&new Date(user.LockedUntil)>new Date())){
    if(user)await query('UPDATE dbo.Users SET FailedAttempts=FailedAttempts+1,LockedUntil=CASE WHEN FailedAttempts>=4 THEN DATEADD(minute,15,SYSUTCDATETIME()) ELSE LockedUntil END WHERE Id=@id',{id:p.id(user.Id)});
    await audit(query,req,'auth.login_failed',null,{provider:'local'});
    return null;
   }
   await query('UPDATE dbo.Users SET FailedAttempts=0,LockedUntil=NULL WHERE Id=@id',{id:p.id(user.Id)});
   if(!mockLoginAllowed(config,req,user)&&mfaRequiredForUser(config,user))return challenge(query,user);
   return createSession(query,req,user);
  });
  requireCondition(result,401,'INVALID_CREDENTIALS','Invalid credentials or account temporarily unavailable.');
  if(result.raw)return sendSession(res,result);
  res.json(result);
 }
 async function loginWithAd(req,res){
  let identity;
  try{identity=await directory.authenticate(req.body.employeeId,req.body.password);}
  catch(error){await audit(db.query,req,error.status===503?'auth.ad_unavailable':'auth.ad_login_failed',null,{provider:'ad',...error.diagnostic});throw error;}
  const result=await db.transaction(async query=>{
   const resolved=await resolveAdProfile(query,identity,req,{matchEmployeeId:config.AUTH_MODE==='ad'});
   if(resolved.conflict){await audit(query,req,'auth.ad_identity_conflict',null,{provider:'ad'});return {identityConflict:true};}
   const user=resolved.user;
   if(!user){
    if(config.AUTH_MODE==='ad')return beginDirectoryEnrollment(query,identity,req);
    await audit(query,req,'auth.ad_link_required',null,{provider:'ad',systemId:identity.systemId});return {linkRequired:true};
   }
   const available=user.Active&&!user.IsDemo&&!(user.LockedUntil&&new Date(user.LockedUntil)>new Date())&&user.EmployeeId.toUpperCase()===identity.employeeId.toUpperCase();
   if(!available){await audit(query,req,'auth.ad_login_failed',user.Id,{provider:'ad'});return null;}
   await query('UPDATE dbo.Users SET FailedAttempts=0,LockedUntil=NULL WHERE Id=@id',{id:p.id(user.Id)});
   await audit(query,{...req,user},'auth.ad_verified',user.Id,{provider:'ad',systemId:identity.systemId});
   if(mfaRequiredForUser(config,user))return challenge(query,user,'ad');
   return createSession(query,req,user,'ad');
  });
  requireCondition(result,401,'INVALID_CREDENTIALS','Invalid credentials or account temporarily unavailable.');
  requireCondition(!result.identityConflict,403,'AD_IDENTITY_CONFLICT','The verified AD identity differs from the registered identity. Contact your UIDMS administrator.');
  requireCondition(!result.linkRequired,403,'AD_PROFILE_NOT_LINKED','AD credentials were verified. Contact IT to create or link your UIDMS profile.');
  if(result.raw)return sendSession(res,result);
  res.json(result);
 }
 async function getChallenge(query,raw){
  const row=(await query("SELECT c.*,u.MfaSecret,u.MfaLastCounter,u.MfaFailedAttempts,u.EmployeeId,u.Active,u.LockedUntil FROM dbo.AuthChallenges c WITH(UPDLOCK,HOLDLOCK) JOIN dbo.Users u WITH(UPDLOCK,HOLDLOCK) ON u.Id=c.UserId WHERE c.TokenHash=@hash AND c.Purpose='mfa' AND c.ExpiresAt>SYSUTCDATETIME()",{hash:p.str(digest(raw),64)})).recordset[0];
  requireCondition(row&&row.Active,401,'CHALLENGE_INVALID','This sign-in attempt has expired or is no longer valid. Close this window and sign in again.');
  requireCondition(!row.LockedUntil||new Date(row.LockedUntil)<=new Date(),401,'MFA_LOCKED','Too many unsuccessful verification attempts. Wait 15 minutes, then sign in again.');
  requireCondition((row.Attempts||0)<5,401,'MFA_ATTEMPTS_EXCEEDED','Too many incorrect codes. Close this window and sign in again.');
  requireCondition(providerEnabled(config,row.AuthProvider||'local'),401,'AUTH_PROVIDER_DISABLED');
  return row;
 }
 function totp(secret,label){return new OTPAuth.TOTP({issuer:'CBC UIDMS',label,algorithm:'SHA1',digits:6,period:30,secret:OTPAuth.Secret.fromBase32(secret)});}
 async function enroll(req,res){
  const result=await db.transaction(async query=>{
   const row=await getChallenge(query,req.body.challenge);
   requireCondition(!row.MfaSecret,409,'MFA_ALREADY_ENABLED','This account already has an authenticator. Close this window and sign in again to use it.');
   const secret=new OTPAuth.Secret({size:20}).base32;
   await query('UPDATE dbo.AuthChallenges SET PendingMfaSecret=@secret WHERE TokenHash=@hash',{secret:p.str(seal(secret,config.DATA_ENCRYPTION_KEY,`mfa:${row.UserId}`),500),hash:p.str(row.TokenHash,64)});
   return {secret,otpauthUrl:totp(secret,row.EmployeeId).toString()};
  });
  res.json(result);
 }
 async function verifyMfa(req,res){
  const result=await db.transaction(async query=>{
   const row=await getChallenge(query,req.body.challenge);
   const encrypted=row.MfaSecret||row.PendingMfaSecret;
   requireCondition(encrypted,400,'MFA_ENROLLMENT_REQUIRED','Set up your authenticator first. Select Show QR code and scan it before entering a code.');
   const secret=unseal(encrypted,config.DATA_ENCRYPTION_KEY,`mfa:${row.UserId}`);
   const timestamp=Date.now();
   const delta=totp(secret,row.EmployeeId).validate({token:req.body.code,window:1,timestamp});
   const counter=Math.floor(timestamp/30000)+(delta??0);
   if(delta===null||(row.MfaLastCounter!==null&&counter<=Number(row.MfaLastCounter))){
    await query('UPDATE dbo.AuthChallenges SET Attempts=Attempts+1 WHERE TokenHash=@hash; UPDATE dbo.Users SET MfaFailedAttempts=MfaFailedAttempts+1,LockedUntil=CASE WHEN MfaFailedAttempts>=4 THEN DATEADD(minute,15,SYSUTCDATETIME()) ELSE LockedUntil END WHERE Id=@user',{hash:p.str(row.TokenHash,64),user:p.id(row.UserId)});
    await audit(query,req,'auth.mfa_failed',null);
    if((row.MfaFailedAttempts||0)>=4)return {mfaError:'MFA_LOCKED'};
    if((row.Attempts||0)>=4)return {mfaError:'MFA_ATTEMPTS_EXCEEDED'};
    return {mfaError:delta===null?'MFA_INVALID':'MFA_CODE_USED'};
   }
   await query('UPDATE dbo.Users SET MfaSecret=@secret,MfaLastCounter=@counter,FailedAttempts=0,MfaFailedAttempts=0,LockedUntil=NULL WHERE Id=@user; DELETE dbo.AuthChallenges WHERE UserId=@user AND Purpose=\'mfa\'',{secret:p.str(encrypted,500),counter:{type:sql.BigInt,value:counter},user:p.id(row.UserId)});
   const user=(await query(`SELECT ${userColumns} FROM dbo.Users u WHERE u.Id=@id`,{id:p.id(row.UserId)})).recordset[0];
   return createSession(query,req,user,row.AuthProvider||'local');
  });
  const messages={
   MFA_INVALID:'That code is incorrect or has expired. Enter the latest six-digit code for CBC UIDMS from your authenticator app.',
   MFA_CODE_USED:'This code has already been used. Wait for a new code in your authenticator app, then try again.',
   MFA_LOCKED:'Too many unsuccessful verification attempts. Wait 15 minutes, then sign in again.',
   MFA_ATTEMPTS_EXCEEDED:'Too many incorrect codes. Close this window and sign in again.',
  };
  requireCondition(!result.mfaError,401,result.mfaError,messages[result.mfaError]);sendSession(res,result);
 }
 async function activate(req,res){
  requireCondition(providerEnabled(config,'local'),503,'AUTH_PROVIDER_DISABLED','Local account activation is not enabled.');
  const passwordHash=await hashPassword(req.body.password);
  const result=await db.transaction(async query=>{
   const row=(await query("SELECT c.*,u.Active,u.PasswordHash FROM dbo.AuthChallenges c WITH(UPDLOCK,HOLDLOCK) JOIN dbo.Users u ON u.Id=c.UserId WHERE c.TokenHash=@hash AND c.Purpose='activation' AND c.ExpiresAt>SYSUTCDATETIME()",{hash:p.str(digest(req.body.token),64)})).recordset[0];
   requireCondition(row&&row.Active&&!row.PasswordHash,401,'ACTIVATION_INVALID');
   await query("UPDATE dbo.Users SET PasswordHash=@password WHERE Id=@id; DELETE dbo.AuthChallenges WHERE TokenHash=@hash",{password:p.str(passwordHash,300),id:p.id(row.UserId),hash:p.str(row.TokenHash,64)});
   await audit(query,req,'auth.activated',row.UserId);
   return challenge(query,{Id:row.UserId});
  });res.json(result);
 }
 const finishOnboarding=(query,req,user)=>mfaPausedForTesting(config)?createSession(query,req,user,'ad'):challenge(query,user,'ad');
 return {authenticate,login,enroll,verifyMfa,activate,cookieName,cookieOptions,sendSession,...createDirectoryOnboarding(db,config,finishOnboarding,sendSession)};
}
export const roles=(...allowed)=>(req,res,next)=>{requireCondition(hasRole(req.user,...allowed),403,'FORBIDDEN');next();};
export function recentAuth(req,res,next){requireCondition(Date.now()-new Date(req.user.AuthenticatedAt).getTime()<10*60*1000,403,'REAUTHENTICATION_REQUIRED','Sign in again before this sensitive action.');next();}
