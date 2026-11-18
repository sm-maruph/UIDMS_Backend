import * as OTPAuth from 'otpauth';
import {p,sql} from '../../core/db.js';
import {token,digest,equal,hashPassword,verifyPassword,seal,unseal} from '../../core/crypto.js';
import {HttpError,requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';

export const publicUser=user=>({id:user.Id,employeeId:user.EmployeeId,name:user.Name,email:user.Email,role:user.Role,branchId:user.BranchId,departmentId:user.DepartmentId,designationId:user.DesignationId,active:user.Active,version:user.Version?.toString('hex')});
export const userColumns='u.Id,u.EmployeeId,u.Name,u.Email,u.Role,u.BranchId,u.DepartmentId,u.DesignationId,u.Active,u.Version';
export function createAuth(db,config){
 const cookieName=config.COOKIE_SECURE?'__Host-uidms':'uidms_dev';
 const cookieOptions={httpOnly:true,secure:config.COOKIE_SECURE,sameSite:'strict',path:'/',maxAge:config.SESSION_MAX_HOURS*3600000};
 async function createSession(query,req,user){
  const raw=token(),csrf=token();
  await query('UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@user AND RevokedAt IS NULL',{user:p.id(user.Id)});
  await query('INSERT dbo.Sessions(TokenHash,UserId,CsrfHash,ExpiresAt,Ip,UserAgent) VALUES(@token,@user,@csrf,DATEADD(hour,@hours,SYSUTCDATETIME()),@ip,@agent)',{token:p.str(digest(raw),64),user:p.id(user.Id),csrf:p.str(digest(csrf),64),hours:p.int(config.SESSION_MAX_HOURS),ip:p.str(req.ip,64),agent:p.text(String(req.get('user-agent')||'').slice(0,300),300)});
  await audit(query,{...req,user},'auth.login',user.Id);
  return {raw,csrf,user:publicUser(user)};
 }
 function sendSession(res,result){res.cookie(cookieName,result.raw,cookieOptions);res.json({user:result.user,csrfToken:result.csrf});}
 async function authenticate(req,res,next){
  const raw=req.cookies?.[cookieName];
  requireCondition(typeof raw==='string'&&/^[\w-]{43}$/.test(raw),401,'UNAUTHENTICATED');
  const hash=digest(raw);
  const result=await db.query(`UPDATE dbo.Sessions SET LastSeenAt=SYSUTCDATETIME() OUTPUT inserted.TokenHash WHERE TokenHash=@hash AND RevokedAt IS NULL AND ExpiresAt>SYSUTCDATETIME() AND LastSeenAt>DATEADD(minute,-@idle,SYSUTCDATETIME()); SELECT ${userColumns},s.CsrfHash,s.CreatedAt AS AuthenticatedAt FROM dbo.Sessions s JOIN dbo.Users u ON u.Id=s.UserId WHERE s.TokenHash=@hash AND u.Active=1 AND s.RevokedAt IS NULL AND s.ExpiresAt>SYSUTCDATETIME() AND s.LastSeenAt>DATEADD(minute,-@idle,SYSUTCDATETIME())`,{hash:p.str(hash,64),idle:p.int(config.SESSION_IDLE_MINUTES)});
  requireCondition(result.recordsets[0]?.length&&result.recordsets[1]?.length,401,'SESSION_EXPIRED');
  req.user=result.recordsets[1][0];req.sessionHash=hash;
  if(!['GET','HEAD','OPTIONS'].includes(req.method))requireCondition(equal(digest(String(req.get('x-csrf-token')||'')),req.user.CsrfHash),403,'CSRF_INVALID');
  next();
 }
 async function challenge(query,user){
  const raw=token();
  await query("DELETE dbo.AuthChallenges WHERE UserId=@user AND Purpose='mfa'; INSERT dbo.AuthChallenges(TokenHash,UserId,Purpose,ExpiresAt) VALUES(@hash,@user,'mfa',DATEADD(minute,5,SYSUTCDATETIME()))",{user:p.id(user.Id),hash:p.str(digest(raw),64)});
  return {challenge:raw,mfaEnrollmentRequired:!user.MfaSecret,expiresInSeconds:300};
 }
 async function login(req,res){
  const {employeeId,password}=req.body;
  const found=(await db.query('SELECT TOP(1) * FROM dbo.Users WHERE EmployeeId=@employee',{employee:p.text(employeeId,40)})).recordset[0];
  const valid=await verifyPassword(password,found?.PasswordHash);
  const result=await db.transaction(async query=>{
   const user=found?(await query('SELECT * FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id',{id:p.id(found.Id)})).recordset[0]:null;
   if(!user||!user.Active||!valid||user.PasswordHash!==found.PasswordHash||(user.LockedUntil&&new Date(user.LockedUntil)>new Date())){
    if(user)await query('UPDATE dbo.Users SET FailedAttempts=FailedAttempts+1,LockedUntil=CASE WHEN FailedAttempts>=4 THEN DATEADD(minute,15,SYSUTCDATETIME()) ELSE LockedUntil END WHERE Id=@id',{id:p.id(user.Id)});
    await audit(query,req,'auth.login_failed',null);
    return null;
   }
   await query('UPDATE dbo.Users SET FailedAttempts=0,LockedUntil=NULL WHERE Id=@id',{id:p.id(user.Id)});
   if(config.MFA_REQUIRED||user.MfaSecret)return challenge(query,user);
   return createSession(query,req,user);
  });
  requireCondition(result,401,'INVALID_CREDENTIALS','Invalid credentials or account temporarily unavailable.');
  if(result.raw)return sendSession(res,result);
  res.json(result);
 }
 async function getChallenge(query,raw){
  const row=(await query("SELECT c.*,u.MfaSecret,u.MfaLastCounter,u.EmployeeId,u.Active,u.LockedUntil FROM dbo.AuthChallenges c WITH(UPDLOCK,HOLDLOCK) JOIN dbo.Users u WITH(UPDLOCK,HOLDLOCK) ON u.Id=c.UserId WHERE c.TokenHash=@hash AND c.Purpose='mfa' AND c.ExpiresAt>SYSUTCDATETIME() AND c.Attempts<5",{hash:p.str(digest(raw),64)})).recordset[0];
  requireCondition(row&&row.Active&&(!row.LockedUntil||new Date(row.LockedUntil)<=new Date()),401,'CHALLENGE_INVALID');
  return row;
 }
 function totp(secret,label){return new OTPAuth.TOTP({issuer:'CBC UIDMS',label,algorithm:'SHA1',digits:6,period:30,secret:OTPAuth.Secret.fromBase32(secret)});}
 async function enroll(req,res){
  const result=await db.transaction(async query=>{
   const row=await getChallenge(query,req.body.challenge);
   requireCondition(!row.MfaSecret,409,'MFA_ALREADY_ENABLED');
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
   requireCondition(encrypted,400,'MFA_ENROLLMENT_REQUIRED');
   const secret=unseal(encrypted,config.DATA_ENCRYPTION_KEY,`mfa:${row.UserId}`);
   const timestamp=Date.now();
   const delta=totp(secret,row.EmployeeId).validate({token:req.body.code,window:1,timestamp});
   const counter=Math.floor(timestamp/30000)+(delta??0);
   if(delta===null||(row.MfaLastCounter!==null&&counter<=Number(row.MfaLastCounter))){
    await query('UPDATE dbo.AuthChallenges SET Attempts=Attempts+1 WHERE TokenHash=@hash; UPDATE dbo.Users SET MfaFailedAttempts=MfaFailedAttempts+1,LockedUntil=CASE WHEN MfaFailedAttempts>=4 THEN DATEADD(minute,15,SYSUTCDATETIME()) ELSE LockedUntil END WHERE Id=@user',{hash:p.str(row.TokenHash,64),user:p.id(row.UserId)});
    await audit(query,req,'auth.mfa_failed',null);return null;
   }
   await query('UPDATE dbo.Users SET MfaSecret=@secret,MfaLastCounter=@counter,FailedAttempts=0,MfaFailedAttempts=0,LockedUntil=NULL WHERE Id=@user; DELETE dbo.AuthChallenges WHERE UserId=@user AND Purpose=\'mfa\'',{secret:p.str(encrypted,500),counter:{type:sql.BigInt,value:counter},user:p.id(row.UserId)});
   const user=(await query(`SELECT ${userColumns} FROM dbo.Users u WHERE u.Id=@id`,{id:p.id(row.UserId)})).recordset[0];
   return createSession(query,req,user);
  });
  requireCondition(result,401,'MFA_INVALID');sendSession(res,result);
 }
 async function activate(req,res){
  const passwordHash=await hashPassword(req.body.password);
  const result=await db.transaction(async query=>{
   const row=(await query("SELECT c.*,u.Active,u.PasswordHash FROM dbo.AuthChallenges c WITH(UPDLOCK,HOLDLOCK) JOIN dbo.Users u ON u.Id=c.UserId WHERE c.TokenHash=@hash AND c.Purpose='activation' AND c.ExpiresAt>SYSUTCDATETIME()",{hash:p.str(digest(req.body.token),64)})).recordset[0];
   requireCondition(row&&row.Active&&!row.PasswordHash,401,'ACTIVATION_INVALID');
   await query("UPDATE dbo.Users SET PasswordHash=@password WHERE Id=@id; DELETE dbo.AuthChallenges WHERE TokenHash=@hash",{password:p.str(passwordHash,300),id:p.id(row.UserId),hash:p.str(row.TokenHash,64)});
   await audit(query,req,'auth.activated',row.UserId);
   return challenge(query,{Id:row.UserId});
  });res.json(result);
 }
 return {authenticate,login,enroll,verifyMfa,activate,cookieName,cookieOptions,sendSession};
}
export const roles=(...allowed)=>(req,res,next)=>{requireCondition(allowed.includes(req.user.Role),403,'FORBIDDEN');next();};
export function recentAuth(req,res,next){requireCondition(Date.now()-new Date(req.user.AuthenticatedAt).getTime()<10*60*1000,403,'REAUTHENTICATION_REQUIRED','Sign in again before this sensitive action.');next();}
