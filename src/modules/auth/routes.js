import {Router} from 'express';
import {z,text,parse} from '../../core/validation.js';
import {p} from '../../core/db.js';
import {token,digest,hashPassword,verifyPassword} from '../../core/crypto.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';
import {publicUser} from './service.js';
import {localMockRequest} from './mock-policy.js';
import {localLoginEnabled,adLoginEnabled} from './providers.js';
import {enrollmentTokenSchema,enrollmentProfileSchema} from './directory-onboarding.js';
export const passwordSchema=z.string().min(15).max(128).refine(value=>!/^(.)(\1)+$/.test(value)&&!['passwordpassword','Password123456!'].includes(value),'Choose a less predictable passphrase');
const challengeSchema=z.object({challenge:z.string().regex(/^[\w-]{43}$/)}).strict();
const validate=schema=>(req,res,next)=>{req.body=parse(schema,req.body);next();};
export function authRoutes(db,auth,config){
 const router=Router();
 router.get('/options',(req,res)=>res.json({mockLogin:localLoginEnabled(config)&&localMockRequest(config,req),localLogin:localLoginEnabled(config),adLogin:adLoginEnabled(config)}));
 router.get('/mock-directory',async(req,res)=>{
  requireCondition(localLoginEnabled(config)&&localMockRequest(config,req),404,'NOT_FOUND');
  const result=await db.query('SELECT EmployeeId AS employeeId,Name AS name,Role AS role FROM dbo.Users WHERE IsDemo=1 AND Active=1 ORDER BY Name');
  res.json({users:result.recordset});
 });
 if(localLoginEnabled(config)&&process.env.UIDMS_DEMO_DIRECTORY==='true'&&process.env.NODE_ENV==='development'&&process.env.HOST==='127.0.0.1'){
  router.get('/demo-directory',async(req,res)=>{
   requireCondition(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress),404,'NOT_FOUND');
   const {recordset:users}=await db.query('SELECT EmployeeId AS employeeId,Name AS name FROM dbo.Users WHERE Active=1 ORDER BY Name');
   res.json({users});
  });
 }
 router.post('/login',validate(z.object({employeeId:text(160),password:z.string().min(1).max(128),provider:z.enum(['local','ad']).default(config.AUTH_MODE==='ad'?'ad':'local')}).strict().refine(body=>body.provider!=='local'||body.employeeId.length<=40,{path:['employeeId'],message:'Local employee IDs must not exceed 40 characters.'})),auth.login);
 router.post('/activate',validate(z.object({token:z.string().regex(/^[\w-]{43}$/),password:passwordSchema}).strict()),auth.activate);
 router.post('/mfa/enroll',validate(challengeSchema),auth.enroll);
 router.post('/mfa/verify',validate(challengeSchema.extend({code:z.string().regex(/^\d{6}$/)})),auth.verifyMfa);
 router.post('/onboarding/options',validate(z.object({onboardingToken:enrollmentTokenSchema}).strict()),auth.onboardingOptions);
 router.post('/onboarding/complete',validate(enrollmentProfileSchema),auth.completeOnboarding);
 router.use(auth.authenticate);
 router.get('/session',async(req,res)=>{
  const csrf=token();await db.query('UPDATE dbo.Sessions SET CsrfHash=@csrf WHERE TokenHash=@hash',{csrf:p.str(digest(csrf),64),hash:p.str(req.sessionHash,64)});
  res.json({user:publicUser(req.user),csrfToken:csrf,provider:req.user.AuthProvider||'local'});
 });
 router.post('/logout',async(req,res)=>{await db.transaction(async query=>{await query('UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE TokenHash=@hash',{hash:p.str(req.sessionHash,64)});await audit(query,req,'auth.logout',req.user.Id);});res.clearCookie(auth.cookieName,{...auth.cookieOptions,maxAge:undefined});res.status(204).end();});
 router.post('/password',validate(z.object({currentPassword:z.string().max(128),newPassword:passwordSchema}).strict()),async(req,res)=>{
  requireCondition(localLoginEnabled(config),403,'LOCAL_LOGIN_DISABLED','UIDMS uses Active Directory. Change your password through your organization’s AD password service.');
  const user=(await db.query('SELECT PasswordHash FROM dbo.Users WHERE Id=@id',{id:p.id(req.user.Id)})).recordset[0];
  requireCondition(await verifyPassword(req.body.currentPassword,user.PasswordHash),401,'INVALID_CREDENTIALS');
  const hash=await hashPassword(req.body.newPassword);
  await db.transaction(async query=>{await query('UPDATE dbo.Users SET PasswordHash=@hash,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id AND PasswordHash=@old; UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@id',{hash:p.str(hash,300),old:p.str(user.PasswordHash,300),id:p.id(req.user.Id)});await audit(query,req,'auth.password_changed',req.user.Id);});
  res.clearCookie(auth.cookieName,{...auth.cookieOptions,maxAge:undefined});res.status(204).end();
 });
 return router;
}
