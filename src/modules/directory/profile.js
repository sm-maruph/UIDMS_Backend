import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,id,text,parse} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {publicUser,userColumns} from '../auth/service.js';
import {canRecordAccess} from '../auth/authorization.js';
import {audit} from '../audit/service.js';
import {validFile} from '../attachments/routes.js';
import {version} from '../requests/schemas.js';
import {optionalEmailSchema} from '../auth/directory-onboarding.js';

const signatureSchema=z.string().max(349528).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const accessSchema=z.object({systemId:id,systemRoleId:id.nullable().default(null),username:text(150,0).default('')}).strict();
const editSchema=z.object({version,designationId:id.nullable(),email:optionalEmailSchema.optional(),access:z.array(accessSchema).max(300).optional(),signatureBase64:signatureSchema.optional()}).strict();
const key=row=>`${row.SystemId}:${row.SystemRoleId||''}`;
const readAccess='SELECT g.Id,g.SystemId,s.Name AS SystemName,g.SystemRoleId,sr.Name AS RoleName,g.Username,g.GrantedAt,g.SourceRequestId FROM dbo.AccessGrants g JOIN dbo.Systems s ON s.Id=g.SystemId LEFT JOIN dbo.SystemRoles sr ON sr.Id=g.SystemRoleId WHERE g.UserId=@id AND g.RevokedAt IS NULL ORDER BY s.Name,sr.Name';

async function updateRecordedAccess(query,userId,access){
 const params={id:p.id(userId)};
 const existing=(await query(readAccess,params)).recordset;
 const previous=new Map(existing.map(row=>[key(row),row]));
 const requested=new Map(access.map(row=>[`${row.systemId}:${row.systemRoleId||''}`,row]));
 requireCondition(requested.size===access.length,400,'DUPLICATE_ACCESS','Each system and role can be listed only once.');
 const systems=(await query('SELECT s.Id,sr.Id AS RoleId FROM dbo.Systems s LEFT JOIN dbo.SystemRoles sr ON sr.SystemId=s.Id AND sr.Active=1 WHERE s.Active=1')).recordset;
 for(const [entry,row] of requested){
  // Preserve a retired catalogue entry that is already recorded; never newly assign it.
  if(previous.has(entry)&&String(previous.get(entry).Username||'')===row.username)continue;
  const choices=systems.filter(system=>system.Id===row.systemId);
  requireCondition(choices.length&&choices.some(system=>row.systemRoleId?system.RoleId===row.systemRoleId:!system.RoleId),400,'INVALID_SYSTEM_ROLE','Choose an active system and one of its roles.');
 }
 for(const row of existing)if(!requested.has(key(row)))await query('UPDATE dbo.AccessGrants SET RevokedAt=SYSUTCDATETIME() WHERE Id=@grant AND UserId=@id AND RevokedAt IS NULL',{...params,grant:p.id(row.Id)});
 for(const [entry,row] of requested){
  const old=previous.get(entry);
  const values={...params,system:p.id(row.systemId),role:p.id(row.systemRoleId),username:p.text(row.username||null,150)};
  if(!old)await query('INSERT dbo.AccessGrants(UserId,SystemId,SystemRoleId,Username) VALUES(@id,@system,@role,@username)',values);
  else if(String(old.Username||'')!==row.username)await query('UPDATE dbo.AccessGrants SET Username=@username WHERE Id=@grant AND UserId=@id AND RevokedAt IS NULL',{...values,grant:p.id(old.Id)});
 }
 return {previous:existing.map(row=>({systemId:row.SystemId,systemRoleId:row.SystemRoleId,username:row.Username})),current:access};
}

export function profileRoutes(db,config){
 const router=Router();
 const notificationEmailDomains=(config.MAIL_ALLOWED_DOMAINS||'combankbd.com').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);
 router.get('/profile',async(req,res)=>{
  const params={id:p.id(req.user.Id)};
  const current=(await db.query(`SELECT ${userColumns} FROM dbo.Users u WHERE u.Id=@id`,params)).recordset[0];
  requireCondition(current,404,'USER_NOT_FOUND');
  const access=(await db.query(readAccess,params)).recordset;
  res.json({user:publicUser(current),access,canEditAccess:canRecordAccess(req.user),notificationEmailDomains});
 });
 router.patch('/profile',async(req,res)=>{
  const body=parse(editSchema,req.body);
  if(body.email)requireCondition(notificationEmailDomains.includes(body.email.split('@')[1].toLowerCase()),400,'COMPANY_EMAIL_REQUIRED','Enter your company email address for UIDMS notifications.');
  const signature=body.signatureBase64===undefined?null:Buffer.from(body.signatureBase64,'base64');
  if(signature)requireCondition(signature.length<=262144&&validFile(signature,'image/png'),400,'PNG_SIGNATURE_REQUIRED');
  const user=await db.transaction(async query=>{
   const params={id:p.id(req.user.Id)};
   const current=(await query('SELECT Id,DesignationId,IsDemo,Version,Email FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id',params)).recordset[0];
   requireCondition(current,404,'USER_NOT_FOUND');
   requireCondition(current.Version.toString('hex')===body.version,409,'STALE_VERSION','Your profile changed. Reopen Edit profile and try again.');
   if(body.access!==undefined)requireCondition(canRecordAccess(req.user),403,'ACCESS_APPROVAL_REQUIRED','Only IT, Admin and Super Admin may directly record their own system access. Submit an access request for approval.');
   if(body.designationId&&body.designationId!==current.DesignationId)requireCondition((await query("SELECT Id FROM dbo.Lookups WHERE Id=@designation AND Kind='designation' AND Active=1",{designation:p.id(body.designationId)})).recordset.length,400,'INVALID_DESIGNATION');
   const access=body.access===undefined?null:await updateRecordedAccess(query,req.user.Id,body.access);
   const updated=(await query(`UPDATE dbo.Users SET DesignationId=@designation,Email=CASE WHEN @hasEmail=1 THEN @email ELSE Email END,Signature=CASE WHEN @hasSignature=1 THEN @signature ELSE Signature END,SignatureContentType=CASE WHEN @hasSignature=1 THEN 'image/png' ELSE SignatureContentType END,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id; SELECT ${userColumns} FROM dbo.Users u WHERE u.Id=@id`,{...params,designation:p.id(body.designationId),hasEmail:p.bit(body.email!==undefined),email:p.text(body.email,254),hasSignature:p.bit(Boolean(signature)),signature:p.bytes(signature)})).recordset[0];
   await audit(query,req,'profile.updated',req.user.Id,{previousDesignationId:current.DesignationId,designationId:body.designationId,signatureChanged:Boolean(signature),emailChanged:body.email!==undefined&&body.email!==current.Email});
   if(access)await audit(query,req,'profile.access_updated',req.user.Id,access);
   return publicUser(updated);
  });
  res.json({user});
 });
 return router;
}
