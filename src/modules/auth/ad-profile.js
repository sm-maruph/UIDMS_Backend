import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';

// identity must come from a successful server-side AD bind, never from login-form fields.
export async function resolveAdProfile(query,identity,req,{matchEmployeeId=false}={}){
 requireCondition(/^ad:[a-z0-9_-]{1,40}:[a-f0-9]{32}$/.test(identity.systemId)&&/^[A-Za-z0-9_-]{1,40}$/.test(identity.employeeId),503,'DIRECTORY_IDENTITY_INVALID');
 const linked=(await query('SELECT u.* FROM dbo.DirectoryIdentities d WITH(UPDLOCK,HOLDLOCK) JOIN dbo.Users u WITH(UPDLOCK,HOLDLOCK) ON u.Id=d.UserId WHERE d.SystemId=@system',{system:p.text(identity.systemId,160)})).recordset[0];
 if(linked)return {user:linked};
 if(!matchEmployeeId)return {missing:true};
 const user=(await query('SELECT * FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE EmployeeId=@employee',{employee:p.text(identity.employeeId,40)})).recordset[0];
 if(!user)return {missing:true};
 if(!user.Active||user.LockedUntil&&new Date(user.LockedUntil)>new Date()||user.EmployeeId.toUpperCase()!==identity.employeeId.toUpperCase())return {user};
 const params={user:p.id(user.Id),system:p.text(identity.systemId,160)};
 const old=(await query('SELECT SystemId,UserId FROM dbo.DirectoryIdentities WITH(UPDLOCK,HOLDLOCK) WHERE UserId=@user',params)).recordset[0];
 if(old?.SystemId.startsWith('ad:')&&old.SystemId!==identity.systemId)return {conflict:true};
 if(old)await query('UPDATE dbo.DirectoryIdentities SET SystemId=@system,LinkedAt=SYSUTCDATETIME() WHERE UserId=@user',params);
 else await query('INSERT dbo.DirectoryIdentities(SystemId,UserId) VALUES(@system,@user)',params);
 // Preserve the existing profile, role, organization, grants and ticket references.
 if(user.IsDemo||user.PasswordHash){
  const updated=(await query('UPDATE dbo.Users SET IsDemo=0,PasswordHash=NULL,UpdatedAt=SYSUTCDATETIME() OUTPUT inserted.Version WHERE Id=@user',params)).recordset[0];
  user.IsDemo=false;user.PasswordHash=null;if(updated)user.Version=updated.Version;
 }
 await audit(query,{...req,user},'auth.ad_profile_matched',user.Id,{matchedBy:'verified_employee_id',systemId:identity.systemId,previousSystemId:old?.SystemId||null});
 return {user};
}
