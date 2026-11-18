import {Router} from 'express';
import {z,text,parse} from '../../core/validation.js';
import {p} from '../../core/db.js';
import {token,digest,hashPassword,verifyPassword} from '../../core/crypto.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';
import {publicUser} from './service.js';
export const passwordSchema=z.string().min(15).max(128).refine(value=>!/^(.)(\1)+$/.test(value)&&!['passwordpassword','Password123456!'].includes(value),'Choose a less predictable passphrase');
const challengeSchema=z.object({challenge:z.string().regex(/^[\w-]{43}$/)}).strict();
const validate=schema=>(req,res,next)=>{req.body=parse(schema,req.body);next();};
export function authRoutes(db,auth){
 const router=Router();
 router.post('/login',validate(z.object({employeeId:text(40),password:z.string().min(1).max(128)}).strict()),auth.login);
 router.post('/activate',validate(z.object({token:z.string().regex(/^[\w-]{43}$/),password:passwordSchema}).strict()),auth.activate);
 router.post('/mfa/enroll',validate(challengeSchema),auth.enroll);
 router.post('/mfa/verify',validate(challengeSchema.extend({code:z.string().regex(/^\d{6}$/)})),auth.verifyMfa);
 router.use(auth.authenticate);
 router.get('/session',async(req,res)=>{
  const csrf=token();await db.query('UPDATE dbo.Sessions SET CsrfHash=@csrf WHERE TokenHash=@hash',{csrf:p.str(digest(csrf),64),hash:p.str(req.sessionHash,64)});
  res.json({user:publicUser(req.user),csrfToken:csrf});
 });
 router.post('/logout',async(req,res)=>{await db.transaction(async query=>{await query('UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE TokenHash=@hash',{hash:p.str(req.sessionHash,64)});await audit(query,req,'auth.logout',req.user.Id);});res.clearCookie(auth.cookieName,{...auth.cookieOptions,maxAge:undefined});res.status(204).end();});
 router.post('/password',validate(z.object({currentPassword:z.string().max(128),newPassword:passwordSchema}).strict()),async(req,res)=>{
  const user=(await db.query('SELECT PasswordHash FROM dbo.Users WHERE Id=@id',{id:p.id(req.user.Id)})).recordset[0];
  requireCondition(await verifyPassword(req.body.currentPassword,user.PasswordHash),401,'INVALID_CREDENTIALS');
  const hash=await hashPassword(req.body.newPassword);
  await db.transaction(async query=>{await query('UPDATE dbo.Users SET PasswordHash=@hash,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id AND PasswordHash=@old; UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@id',{hash:p.str(hash,300),old:p.str(user.PasswordHash,300),id:p.id(req.user.Id)});await audit(query,req,'auth.password_changed',req.user.Id);});
  res.clearCookie(auth.cookieName,{...auth.cookieOptions,maxAge:undefined});res.status(204).end();
 });
 return router;
}
