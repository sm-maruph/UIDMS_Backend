import {deletionRoutes} from '../admin/deletions.js';
import {routingNameSql} from './organization-names.js';
import {organizationRoutes} from './organizations.js';
import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,id,text,parse,uuidParam,pageSchema} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {token,digest,hashPassword} from '../../core/crypto.js';
import {localMockRequest} from '../auth/mock-policy.js';
import {roles,recentAuth,publicUser,userColumns} from '../auth/service.js';
import {closeAuditSessions} from '../audit/sessions.js';
import {audit} from '../audit/service.js';
import {validFile} from '../attachments/routes.js';
import {version} from '../requests/schemas.js';
import {workflowRoles} from '../requests/policy.js';
import {profileRoutes} from './profile.js';
import {localLoginEnabled} from '../auth/providers.js';
import {hasRole,isAdministrator,canManageAccount} from '../auth/authorization.js';
import {optionalEmailSchema} from '../auth/directory-onboarding.js';
import {portalRequestTypes,isCurrentRequestType} from '../requests/catalog.js';

const roleSchema=z.enum(['User','Branch manager','Department head','IT','CITO','COO','HR','Admin','Platform Admin','Super Admin']);
const profileSchema=z.object({employeeId:text(40).regex(/^[A-Za-z0-9_-]+$/),name:text(160),email:optionalEmailSchema,role:roleSchema,branchId:id,departmentId:id,designationId:id.nullable().optional()}).strict();
const isAdmin=isAdministrator;
export function directoryRoutes(db,config){
 const router=Router();
 router.use(deletionRoutes(db));
 router.use(organizationRoutes(db));
 router.use(profileRoutes(db,config));
 router.put('/profile/signature',async(req,res)=>{
  const body=parse(z.object({base64:z.string().max(349528).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict(),req.body);
  const bytes=Buffer.from(body.base64,'base64');requireCondition(bytes.length<=262144&&validFile(bytes,'image/png'),400,'PNG_SIGNATURE_REQUIRED');
  await db.transaction(async query=>{await query("UPDATE dbo.Users SET Signature=@signature,SignatureContentType='image/png',UpdatedAt=SYSUTCDATETIME() WHERE Id=@id",{signature:p.bytes(bytes),id:p.id(req.user.Id)});await audit(query,req,'profile.signature_updated',req.user.Id);});res.status(204).end();
 });
 router.get('/profile/signature',async(req,res)=>{
  const row=(await db.query('SELECT Signature FROM dbo.Users WHERE Id=@id',{id:p.id(req.user.Id)})).recordset[0];
  requireCondition(row,404,'USER_NOT_FOUND');
  if(!row.Signature)return res.status(204).end();
  res.type('image/png').send(row.Signature);
 });
 router.get('/lookups',async(req,res)=>{
  const result=await db.query(`SELECT l.Id,l.Kind,l.Name,${routingNameSql('l')} AS RoutingName FROM dbo.Lookups l WHERE l.Active=1 ORDER BY l.Kind,l.Name; SELECT Id,Name,TransferManaged FROM dbo.Systems WHERE Active=1 ORDER BY Name; SELECT sr.Id,sr.SystemId,sr.Name FROM dbo.SystemRoles sr JOIN dbo.Systems s ON s.Id=sr.SystemId WHERE sr.Active=1 AND s.Active=1 ORDER BY sr.Name; SELECT rt.Code,rt.Name,rt.IncludesHr,rt.InitiatorRoles,CASE WHEN @catalogAdmin=1 THEN (SELECT COUNT(*) FROM dbo.Requests history WHERE history.TypeCode=rt.Code AND history.DeletedAt IS NULL) ELSE 0 END AS ExistingRequests FROM dbo.RequestTypes rt WHERE rt.Active=1; SELECT TypeCode,Position,Role FROM dbo.WorkflowSteps ORDER BY TypeCode,Position; SELECT g.Id,g.Name,g.Email,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.MailingGroupMembers m WHERE m.GroupId=g.Id AND m.UserId=@actor) THEN 1 ELSE 0 END AS bit) AS IsMember FROM dbo.MailingGroups g WHERE g.Active=1`,{actor:p.id(req.user.Id),catalogAdmin:p.bit(isAdmin(req.user))});
  const types=result.recordsets[3].map(type=>({...type,InitiatorRoles:JSON.parse(type.InitiatorRoles)}));
  res.json({organizations:result.recordsets[0],systems:result.recordsets[1],systemRoles:result.recordsets[2],requestTypes:portalRequestTypes(types),legacyRequestTypes:isAdmin(req.user)?types.filter(type=>!isCurrentRequestType(type.Code)):[],workflowSteps:result.recordsets[4],mailingGroups:result.recordsets[5],mockLoginEnabled:localMockRequest(config,req)});
 });
 router.get('/users',async(req,res)=>{
  const filter=parse(pageSchema.extend({search:text(100,0).default('')}).strict(),req.query);
  const scope=`u.DeletedAt IS NULL AND (u.Id=@actor OR @role IN ('IT','HR','CITO','COO','Admin','Platform Admin','Super Admin') OR EXISTS(SELECT 1 FROM dbo.uidms_ManagedScopes(@actor) ms JOIN dbo.Lookups ml ON ml.Id=ms.ScopeId WHERE (ml.Kind='branch' AND u.BranchId=ms.ScopeId) OR (ml.Kind='department' AND u.DepartmentId=ms.ScopeId))) AND (@search=N'' OR CHARINDEX(@search,u.Name)>0 OR CHARINDEX(@search,u.EmployeeId)>0)`;
  const result=await db.query(`SELECT COUNT(*) AS Total FROM dbo.Users u WHERE ${scope}; SELECT ${userColumns},b.Name AS Branch,d.Name AS Department FROM dbo.Users u LEFT JOIN dbo.Lookups b ON b.Id=u.BranchId LEFT JOIN dbo.Lookups d ON d.Id=u.DepartmentId WHERE ${scope} ORDER BY u.Name,u.Id OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`,{actor:p.id(req.user.Id),role:p.text(req.user.Role,40),branch:p.id(req.user.BranchId),department:p.id(req.user.DepartmentId),search:p.text(filter.search,100),offset:p.int((filter.page-1)*filter.pageSize),size:p.int(filter.pageSize)});
  res.json({items:result.recordsets[1].map(row=>({...publicUser(row),branch:row.Branch,department:row.Department})),total:result.recordsets[0][0].Total,page:filter.page,pageSize:filter.pageSize});
 });
 router.get('/users/:id/access',async(req,res)=>{
  const userId=uuidParam(req);
  const user=(await db.query(`SELECT ${userColumns} FROM dbo.Users u WHERE u.Id=@id`,{id:p.id(userId)})).recordset[0];
  const scoped=user&&(await db.query("SELECT ScopeId FROM dbo.uidms_ManagedScopes(@actor) ms JOIN dbo.Lookups l ON l.Id=ms.ScopeId WHERE (l.Kind='branch' AND ms.ScopeId=@branch) OR (l.Kind='department' AND ms.ScopeId=@department)",{actor:p.id(req.user.Id),branch:p.id(user.BranchId),department:p.id(user.DepartmentId)})).recordset.length>0;
  requireCondition(user&&(scoped||user.Id===req.user.Id||isAdmin(req.user)||hasRole(req.user,'IT','HR','CITO','COO')),404,'USER_NOT_FOUND');
  const result=await db.query('SELECT g.Id,g.SystemId,s.Name AS SystemName,g.SystemRoleId,sr.Name AS RoleName,g.Username,g.GrantedAt,g.SourceRequestId FROM dbo.AccessGrants g JOIN dbo.Systems s ON s.Id=g.SystemId LEFT JOIN dbo.SystemRoles sr ON sr.Id=g.SystemRoleId WHERE g.UserId=@id AND g.RevokedAt IS NULL ORDER BY s.Name,sr.Name',{id:p.id(userId)});
  res.json({user:publicUser(user),access:result.recordset});
 });
 async function validateLookups(query,body){
  for(const [value,kind] of [[body.branchId,'branch'],[body.departmentId,'department'],[body.designationId,'designation']])if(value){const found=await query('SELECT Id FROM dbo.Lookups WHERE Id=@id AND Kind=@kind AND Active=1',{id:p.id(value),kind:p.str(kind,20)});requireCondition(found.recordset.length,400,'INVALID_LOOKUP');}
 }
 router.post('/users',roles('Admin','Super Admin'),recentAuth,async(req,res)=>{
  const body=parse(profileSchema.extend({mock:z.boolean().default(false)}),req.body);requireCondition(canManageAccount(req.user,null,body.role),403,'ADMIN_ROLE_PROTECTED','Only Super Admin can create an administrator.');
  if(body.mock)requireCondition(localMockRequest(config,req),403,'MOCK_LOGIN_DISABLED');
  const password=body.mock?await hashPassword('1234'):null;
  const activationToken=token();
  const result=await db.transaction(async query=>{
   await validateLookups(query,body);
   const created=(await query('INSERT dbo.Users(EmployeeId,Name,Email,Role,BranchId,DepartmentId,DesignationId,PasswordHash,IsDemo) OUTPUT inserted.Id VALUES(@employee,@name,@email,@role,@branch,@department,@designation,@password,@demo)',{employee:p.text(body.employeeId,40),name:p.text(body.name,160),email:p.text(body.email,254),role:p.text(body.role,40),branch:p.id(body.branchId),department:p.id(body.departmentId),designation:p.id(body.designationId),password:p.str(password,300),demo:p.bit(body.mock)})).recordset[0];
   if(!body.mock&&localLoginEnabled(config))await query("INSERT dbo.AuthChallenges(TokenHash,UserId,Purpose,ExpiresAt) VALUES(@hash,@user,'activation',DATEADD(hour,24,SYSUTCDATETIME()))",{hash:p.str(digest(activationToken),64),user:p.id(created.Id)});
   await audit(query,req,body.mock?'mock.user_created':'user.created',created.Id,{role:body.role});return created;
  });res.status(201).json(body.mock?{id:result.Id,mock:true}:localLoginEnabled(config)?{id:result.Id,activationToken,expiresInHours:24}:{id:result.Id,authentication:'ad'});
 });
 router.patch('/users/:id',roles('Admin','Super Admin'),recentAuth,async(req,res)=>{
  const userId=uuidParam(req),body=parse(profileSchema.omit({employeeId:true}).extend({active:z.boolean(),version}).strict(),req.body);
  requireCondition(userId!==req.user.Id,403,'SELF_ADMINISTRATION_FORBIDDEN');
  await db.transaction(async query=>{
   const user=(await query('SELECT Id,Role,Version,Active FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND DeletedAt IS NULL',{id:p.id(userId)})).recordset[0];requireCondition(user,404,'USER_NOT_FOUND');requireCondition(user.Version.toString('hex')===body.version,409,'STALE_VERSION');
   requireCondition(canManageAccount(req.user,user.Role,body.role),403,'ADMIN_ROLE_PROTECTED','Only Super Admin can create or promote administrator accounts.');
   requireCondition(hasRole(req.user,'Super Admin')||user.Active!==false||!body.active||!['Admin','Platform Admin','Super Admin'].includes(body.role),403,'ADMIN_ROLE_PROTECTED','Only Super Admin can reactivate an administrator account.');
   if(user.Role==='Super Admin'&&(!body.active||body.role!=='Super Admin'))requireCondition((await query("SELECT COUNT(*) AS Total FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Role='Super Admin' AND Active=1")).recordset[0].Total>1,409,'LAST_SUPER_ADMIN');
   if(user.Role!==body.role||!body.active)await query('UPDATE dbo.RoleDelegations SET RevokedAt=SYSUTCDATETIME(),RevokedBy=@actor WHERE (PrincipalId=@id OR ActingUserId=@id) AND RevokedAt IS NULL',{id:p.id(userId),actor:p.id(req.user.Id)});
   await validateLookups(query,body);
   await closeAuditSessions(query,{userId,reason:!body.active?'account_disabled':user.Role!==body.role?'role_changed':'account_updated'});
   await query('UPDATE dbo.Users SET Name=@name,Email=@email,Role=@role,BranchId=@branch,DepartmentId=@department,DesignationId=@designation,Active=@active,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id; UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@id',{id:p.id(userId),name:p.text(body.name,160),email:p.text(body.email,254),role:p.text(body.role,40),branch:p.id(body.branchId),department:p.id(body.departmentId),designation:p.id(body.designationId),active:p.bit(body.active)});await audit(query,req,'user.updated',userId,{previousRole:user.Role,role:body.role,active:body.active});
  });res.status(204).end();
 });
 router.post('/systems',roles('Admin','Super Admin'),recentAuth,async(req,res)=>{
  const body=parse(z.object({name:text(150),roles:z.array(text(150)).max(100).default([])}).strict(),req.body);
  const result=await db.transaction(async query=>{const row=(await query('INSERT dbo.Systems(Name) OUTPUT inserted.Id VALUES(@name)',{name:p.text(body.name,150)})).recordset[0];for(const name of new Set(body.roles))await query('INSERT dbo.SystemRoles(SystemId,Name) VALUES(@id,@name)',{id:p.id(row.Id),name:p.text(name,150)});await audit(query,req,'system.created',row.Id);return row;});res.status(201).json(result);
 });
 router.put('/workflows/:code',roles('Admin','Super Admin'),recentAuth,async(req,res)=>{
  const code=parse(z.string().regex(/^[a-z-]{1,50}$/),req.params.code);const body=parse(z.object({steps:z.array(z.enum(['Manager','HR','IT','CITO','COO'])).min(1).max(5)}).strict(),req.body);
  await db.transaction(async query=>{const type=(await query('SELECT IncludesHr FROM dbo.RequestTypes WITH(UPDLOCK,HOLDLOCK) WHERE Code=@code',{code:p.str(code,50)})).recordset[0];requireCondition(type,404,'REQUEST_TYPE_NOT_FOUND');const required=workflowRoles(code,type.IncludesHr);requireCondition(JSON.stringify(body.steps)===JSON.stringify(required),400,'INVALID_APPROVAL_CHAIN','Reset/unlock requires CITO only; other approval chains retain their required stages.');await query('DELETE dbo.WorkflowSteps WHERE TypeCode=@code',{code:p.str(code,50)});for(const [i,role] of body.steps.entries())await query('INSERT dbo.WorkflowSteps(TypeCode,Position,Role) VALUES(@code,@position,@role)',{code:p.str(code,50),position:p.int(i+1),role:p.text(role,40)});await audit(query,req,'workflow.updated',code,{steps:body.steps});});res.status(204).end();
 });
 router.post('/mailing-groups',roles('Admin','Super Admin'),recentAuth,async(req,res)=>{
  const body=parse(z.object({name:text(160),email:z.email().max(254)}).strict(),req.body);
  const row=await db.transaction(async query=>{const result=(await query('INSERT dbo.MailingGroups(Name,Email) OUTPUT inserted.Id VALUES(@name,@email)',{name:p.text(body.name,160),email:p.text(body.email.toLowerCase(),254)})).recordset[0];await audit(query,req,'mailing_group.created',result.Id);return result;});res.status(201).json(row);
 });
 router.patch('/systems/:id',roles('Admin','Super Admin'),recentAuth,async(req,res)=>{
  const system=uuidParam(req),body=parse(z.object({name:text(150),active:z.boolean(),transferManaged:z.boolean()}).strict(),req.body);
  await db.transaction(async query=>{const result=await query('UPDATE dbo.Systems SET Name=@name,Active=@active,TransferManaged=@transfer OUTPUT inserted.Id WHERE Id=@id',{id:p.id(system),name:p.text(body.name,150),active:p.bit(body.active),transfer:p.bit(body.transferManaged)});requireCondition(result.recordset.length,404,'SYSTEM_NOT_FOUND');await audit(query,req,'system.updated',system,{active:body.active,transferManaged:body.transferManaged});});res.status(204).end();
 });
 return router;
}
