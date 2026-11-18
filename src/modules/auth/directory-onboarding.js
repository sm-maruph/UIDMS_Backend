import {p} from '../../core/db.js';
import {id,parse,text,z} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';
import {publicUser,userColumns} from './service.js';

const systemIdSchema=text(160).refine(value=>!/[\r\n\t]/.test(value));
const profileSchema=z.object({name:text(160),employeeId:text(40).regex(/^[A-Za-z0-9_-]+$/).transform(value=>value.toUpperCase()),
 email:z.email().max(254).transform(value=>value.toLowerCase()),branchId:id,departmentId:id}).strict();

// The adapter must supply the canonical ID from a verified directory session, never the request body or headers.
export async function directoryProfile(db,verifiedSystemId){
 const systemId=parse(systemIdSchema,verifiedSystemId);
 const user=(await db.query(`SELECT ${userColumns} FROM dbo.DirectoryIdentities d JOIN dbo.Users u ON u.Id=d.UserId WHERE d.SystemId=@system`,{system:p.text(systemId,160)})).recordset[0];
 requireCondition(!user||user.Active,403,'ACCOUNT_DISABLED');
 return user?{systemId,user:publicUser(user)}:{systemId,onboardingRequired:true};
}

export async function completeDirectoryProfile(db,verifiedSystemId,input,req){
 const systemId=parse(systemIdSchema,verifiedSystemId),body=parse(profileSchema,input);
 return db.transaction(async query=>{
  const system=p.text(systemId,160),employee=p.text(body.employeeId,40),email=p.text(body.email,254),branch=p.id(body.branchId),department=p.id(body.departmentId);
  const {recordset:[existing]}=await query(`SELECT ${userColumns} FROM dbo.DirectoryIdentities d WITH (UPDLOCK,HOLDLOCK) JOIN dbo.Users u ON u.Id=d.UserId WHERE d.SystemId=@system`,{system});
  if(existing){requireCondition(existing.Active,403,'ACCOUNT_DISABLED');return {systemId,user:publicUser(existing)};}
  const {recordset:organization}=await query("SELECT Id FROM dbo.Lookups WHERE Active=1 AND ((Id=@branch AND Kind='branch') OR (Id=@department AND Kind='department'))",{branch,department});
  requireCondition(organization.length===2,400,'INVALID_ORGANIZATION');
  const {recordset:conflicts}=await query('SELECT Id FROM dbo.Users WITH (UPDLOCK,HOLDLOCK) WHERE EmployeeId=@employee OR Email=@email',{employee,email});
  requireCondition(!conflicts.length,409,'PROFILE_ALREADY_EXISTS','Contact IT to link your existing profile.');
  const {recordset:[user]}=await query(`INSERT dbo.Users(EmployeeId,Name,Email,Role,BranchId,DepartmentId)
   OUTPUT ${userColumns.replaceAll('u.','inserted.')} VALUES(@employee,@name,@email,N'User',@branch,@department)`,{employee,name:p.text(body.name,160),email,branch,department});
  await query('INSERT dbo.DirectoryIdentities(SystemId,UserId) VALUES(@system,@user)',{system,user:p.id(user.Id)});
  await audit(query,{...req,user},'auth.directory_profile_created',user.Id);
  return {systemId,user:publicUser(user)};
 });
}
