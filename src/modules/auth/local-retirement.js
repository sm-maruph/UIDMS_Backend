import {audit} from '../audit/service.js';

export async function retireLocalAuthentication(db,req){
 return db.transaction(async query=>{
  const before=(await query('SELECT COUNT(*) AS Users,SUM(CASE WHEN PasswordHash IS NOT NULL THEN 1 ELSE 0 END) AS LocalPasswords,SUM(CASE WHEN IsDemo=1 THEN 1 ELSE 0 END) AS DemoProfiles FROM dbo.Users WITH(UPDLOCK,HOLDLOCK)')).recordset[0];
  await query('UPDATE dbo.Users SET PasswordHash=NULL,IsDemo=0,UpdatedAt=SYSUTCDATETIME() WHERE PasswordHash IS NOT NULL OR IsDemo=1');
  await query("UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE AuthProvider='local' AND RevokedAt IS NULL; DELETE dbo.AuthChallenges WHERE AuthProvider='local'");
  await audit(query,req,'auth.local_credentials_retired',null,{users:before.Users,passwordsRemoved:before.LocalPasswords||0,demoFlagsRemoved:before.DemoProfiles||0});
  return {usersRetained:before.Users,passwordsRemoved:before.LocalPasswords||0,demoFlagsRemoved:before.DemoProfiles||0};
 });
}
