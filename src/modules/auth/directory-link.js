import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';

// Trusted operator tooling only; never call this with an identity from an HTTP body.
export async function linkDirectoryIdentity(db,identity,employeeId,req,{convertMock=false,replaceLink=false}={}){
 requireCondition(/^ad:[a-z0-9_-]{1,40}:[a-f0-9]{32}$/.test(identity.systemId),400,'INVALID_DIRECTORY_IDENTITY');
 requireCondition(identity.employeeId.toUpperCase()===employeeId.toUpperCase(),409,'EMPLOYEE_ID_MISMATCH','The verified AD employee ID must match the UIDMS profile.');
 return db.transaction(async query=>{
  const user=(await query('SELECT Id,EmployeeId,Role,IsDemo,Active FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE EmployeeId=@employee',{employee:p.text(employeeId,40)})).recordset[0];
  requireCondition(user?.Active,404,'ACTIVE_PROFILE_REQUIRED','Create an active UIDMS user profile first.');
  requireCondition(!user.IsDemo||convertMock,409,'MOCK_CONVERSION_REQUIRED','Use --convert-mock to disable the shared local password and convert this profile.');
  const params={system:p.text(identity.systemId,160),user:p.id(user.Id)};
  const links=(await query('SELECT SystemId,UserId FROM dbo.DirectoryIdentities WITH(UPDLOCK,HOLDLOCK) WHERE SystemId=@system OR UserId=@user',params)).recordset;
  requireCondition(!links.some(row=>row.SystemId===identity.systemId&&row.UserId!==user.Id),409,'DIRECTORY_IDENTITY_ALREADY_LINKED');
  const old=links.find(row=>row.UserId===user.Id);
  requireCondition(!old||old.SystemId===identity.systemId||replaceLink||user.IsDemo&&convertMock,409,'REPLACE_LINK_REQUIRED','Review the existing link and pass --replace-link to replace it.');
  if(old)await query('UPDATE dbo.DirectoryIdentities SET SystemId=@system,LinkedAt=SYSUTCDATETIME() WHERE UserId=@user',params);
  else await query('INSERT dbo.DirectoryIdentities(SystemId,UserId) VALUES(@system,@user)',params);
  if(user.IsDemo)await query('UPDATE dbo.Users SET IsDemo=0,PasswordHash=NULL,FailedAttempts=0,MfaFailedAttempts=0,LockedUntil=NULL,UpdatedAt=SYSUTCDATETIME() WHERE Id=@user',params);
  await query('UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@user AND RevokedAt IS NULL; DELETE dbo.AuthChallenges WHERE UserId=@user',params);
  await audit(query,req,'auth.directory_linked',user.Id,{systemId:identity.systemId,previousSystemId:old?.SystemId||null,convertedMock:Boolean(user.IsDemo)});
  return {employeeId:user.EmployeeId,role:user.Role,convertedMock:Boolean(user.IsDemo)};
 });
}
