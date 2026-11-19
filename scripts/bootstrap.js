import {randomUUID} from 'node:crypto';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {hashPassword} from '../src/core/crypto.js';
import {parse,z,text} from '../src/core/validation.js';
import {passwordSchema} from '../src/modules/auth/routes.js';
import {audit} from '../src/modules/audit/service.js';
import {bootstrapInput} from './bootstrap-input.js';
const input=parse(z.object({employeeId:text(40).regex(/^[A-Za-z0-9_-]+$/),name:text(160),email:z.email().max(254),password:passwordSchema}),await bootstrapInput());
delete process.env.BOOTSTRAP_PASSWORD;
const db=createDatabase(readConfig());
try{
 await db.connect();
 const password=await hashPassword(input.password);
 await db.transaction(async query=>{
  if((await query("SELECT COUNT(*) AS Count FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Role='Super Admin'")).recordset[0].Count)throw new Error('Bootstrap refused: a Super Admin already exists.');
  const branch=(await query("SELECT TOP(1) Id FROM dbo.Lookups WHERE Kind='branch' AND Name='Corporate Office'")).recordset[0];
  const department=(await query("SELECT TOP(1) Id FROM dbo.Lookups WHERE Kind='department' AND Name='IT Department'")).recordset[0];
  if(!branch||!department)throw new Error('Run the reference-data script first.');
  const user=(await query("INSERT dbo.Users(EmployeeId,Name,Email,Role,BranchId,DepartmentId,PasswordHash) OUTPUT inserted.Id VALUES(@employee,@name,@email,'Super Admin',@branch,@department,@password)",{employee:p.text(input.employeeId,40),name:p.text(input.name,160),email:p.text(input.email.toLowerCase(),254),branch:p.id(branch.Id),department:p.id(department.Id),password:p.str(password,300)})).recordset[0];
  await audit(query,{id:randomUUID(),ip:'local-bootstrap',user:{Id:user.Id}},'admin.bootstrapped',user.Id);
 });
 console.log('Initial Super Admin created. Sign in and complete MFA enrollment. No credentials were logged.');
}finally{await db.close();}
