import {p} from '../../core/db.js';
import {id,text,z} from '../../core/validation.js';
import {token,digest} from '../../core/crypto.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';
import {adLoginEnabled} from './providers.js';

export const enrollmentTokenSchema=z.string().regex(/^[\w-]{43}$/);
export const optionalEmailSchema=z.union([z.email().max(254),z.literal(''),z.null()]).optional().transform(value=>value?value.toLowerCase():null);
export const enrollmentProfileSchema=z.object({onboardingToken:enrollmentTokenSchema,name:text(160),email:optionalEmailSchema,branchId:id,departmentId:id}).strict();

// Called only with the canonical identity returned by a successful AD password bind.
export async function beginDirectoryEnrollment(query,identity,req){
 const raw=token();
 const email=z.email().max(254).safeParse(identity.email);
 const profile={employeeId:identity.employeeId,name:typeof identity.name==='string'?identity.name.trim().slice(0,160):'',email:email.success?email.data.toLowerCase():''};
 await query('DELETE dbo.AdEnrollmentChallenges WHERE SystemId=@system OR EmployeeId=@employee; INSERT dbo.AdEnrollmentChallenges(TokenHash,SystemId,EmployeeId,Name,Email,ExpiresAt) VALUES(@hash,@system,@employee,@name,@email,DATEADD(minute,10,SYSUTCDATETIME()))',{
  hash:p.str(digest(raw),64),system:p.text(identity.systemId,160),employee:p.text(profile.employeeId,40),name:p.text(profile.name,160),email:p.text(profile.email||null,254)});
 await audit(query,req,'auth.ad_enrollment_started',null,{provider:'ad',systemId:identity.systemId});
 return {onboardingRequired:true,onboardingToken:raw,profile,expiresInSeconds:600};
}

export function createDirectoryOnboarding(db,config,finishAuthentication,sendSession){
 function enabled(){requireCondition(config.AUTH_MODE==='ad'&&adLoginEnabled(config),503,'AUTH_PROVIDER_DISABLED');}
 async function pending(query,raw){
  const row=(await query('SELECT * FROM dbo.AdEnrollmentChallenges WITH(UPDLOCK,HOLDLOCK) WHERE TokenHash=@hash AND ExpiresAt>SYSUTCDATETIME()',{hash:p.str(digest(raw),64)})).recordset[0];
  requireCondition(row,401,'ENROLLMENT_EXPIRED','Profile setup expired or was completed. Sign in with AD again.');
  return row;
 }
 async function onboardingOptions(req,res){
  enabled();
  const result=await db.transaction(async query=>{
   await pending(query,req.body.onboardingToken);
   const {recordset:organizations}=await query("SELECT Id,Kind,Name FROM dbo.Lookups WHERE Active=1 AND Kind IN ('branch','department') ORDER BY Kind,Name");
   return {organizations};
  });res.json(result);
 }
 async function completeOnboarding(req,res){
  enabled();
  const body=req.body;
  const result=await db.transaction(async query=>{
   const verified=await pending(query,body.onboardingToken);
   // Employee ID and directory identity are taken exclusively from server-side AD verification.
   const params={employee:p.text(verified.EmployeeId,40),system:p.text(verified.SystemId,160),name:p.text(body.name,160),email:p.text(body.email,254),branch:p.id(body.branchId),department:p.id(body.departmentId)};
   const existing=(await query('SELECT Id FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE EmployeeId=@employee OR (@email IS NOT NULL AND Email=@email)',params)).recordset;
   const linked=(await query('SELECT UserId FROM dbo.DirectoryIdentities WITH(UPDLOCK,HOLDLOCK) WHERE SystemId=@system',params)).recordset;
   requireCondition(!existing.length&&!linked.length,409,'PROFILE_ALREADY_EXISTS','An existing profile uses these details. Sign in again or contact your administrator.');
   const organization=(await query("SELECT Id FROM dbo.Lookups WITH(HOLDLOCK) WHERE Active=1 AND ((Id=@branch AND Kind='branch') OR (Id=@department AND Kind='department'))",params)).recordset;
   requireCondition(organization.length===2,400,'INVALID_ORGANIZATION','Select an active branch and department.');
   const user=(await query("INSERT dbo.Users(EmployeeId,Name,Email,Role,BranchId,DepartmentId,PasswordHash,IsDemo) OUTPUT inserted.* VALUES(@employee,@name,@email,N'User',@branch,@department,NULL,0)",params)).recordset[0];
   await query('INSERT dbo.DirectoryIdentities(SystemId,UserId) VALUES(@system,@user); DELETE dbo.AdEnrollmentChallenges WHERE TokenHash=@hash',{
    system:params.system,user:p.id(user.Id),hash:p.str(verified.TokenHash,64)});
   await audit(query,{...req,user},'auth.directory_profile_created',user.Id,{provider:'ad',role:'User'});
   // Normal enrollment requires MFA; the explicit development pause may issue a session.
   return finishAuthentication(query,req,user);
  });
  res.status(201);
  if(result.raw)return sendSession(res,result);
  res.json(result);
 }
 return {onboardingOptions,completeOnboarding};
}
