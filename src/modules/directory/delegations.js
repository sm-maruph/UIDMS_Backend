import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,id,text,parse,uuidParam} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {recentAuth} from '../auth/service.js';
import {hasRole,isAdministrator} from '../auth/authorization.js';
import {audit} from '../audit/service.js';

export const delegationSchema=z.object({principalId:id,employeeId:text(40).regex(/^[A-Za-z0-9_-]+$/),role:z.enum(['Branch manager','Department head','IT','CITO']),scopeId:id.nullable(),startsAt:z.iso.datetime({offset:true}),endsAt:z.iso.datetime({offset:true})}).strict();
export const activeDelegation="d.RevokedAt IS NULL AND d.StartsAt<=SYSUTCDATETIME() AND d.EndsAt>SYSUTCDATETIME()";
async function requireAuthority(query,actor,principal,role,scopeId){
 if(['IT','CITO'].includes(role)){
  requireCondition(!scopeId&&principal.Role===role,400,'INVALID_PRINCIPAL','Choose the permanent holder of this IT or CITO role.');
  requireCondition(isAdministrator(actor)||actor.Id===principal.Id&&(actor.BaseRole||actor.Role)===role,403,'DELEGATION_FORBIDDEN','Only this permanent role holder or an administrator can appoint an acting replacement.');
 }else{
  const scope=(await query("SELECT a.UserId,l.Kind FROM dbo.OrganizationApprovers a WITH(UPDLOCK,HOLDLOCK) JOIN dbo.Lookups l ON l.Id=a.ScopeId AND l.Active=1 WHERE a.ScopeId=@scope",{scope:p.id(scopeId)})).recordset[0];
  requireCondition(scope&&scope.UserId===principal.Id&&scope.Kind===(role==='Branch manager'?'branch':'department'),400,'INVALID_PRINCIPAL','Choose the current permanent manager or head for this scope.');
  requireCondition(hasRole(actor,'IT','Admin','Super Admin')||actor.Id===principal.Id,403,'DELEGATION_FORBIDDEN','You may appoint a replacement only for your own permanent assignments.');
 }
}
async function bumpPending(query,principalId,role,scopeId){
 await query(`UPDATE r SET UpdatedAt=SYSUTCDATETIME() FROM dbo.Requests r
  WHERE r.DeletedAt IS NULL AND r.Status IN ('Employee review','Pending','In review','Query') AND EXISTS(
   SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=r.Id AND s.Status='Waiting' AND s.Role=@role
   AND ((@scope IS NOT NULL AND s.AssignedUserId=@principal AND COALESCE(s.BranchId,s.DepartmentId)=@scope) OR (@scope IS NULL AND s.AssignedUserId IS NULL)))`,{principal:p.id(principalId),role:p.text(role,40),scope:p.id(scopeId)});
}
export async function createDelegation(db,req,body){
 const start=new Date(body.startsAt),end=new Date(body.endsAt);
 requireCondition(Number.isFinite(+start)&&Number.isFinite(+end)&&end>start&&end>Date.now()&&end-start<=366*86400000,400,'INVALID_ACTING_PERIOD','Select an end after the start, in the future, within one year of the start.');
 return db.transaction(async query=>{
  const principal=(await query('SELECT Id,Role,Active,BranchId,DepartmentId FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id',{id:p.id(body.principalId)})).recordset[0];
  requireCondition(principal?.Active,400,'INVALID_PRINCIPAL','Choose an active permanent role holder.');
  await requireAuthority(query,req.user,principal,body.role,body.scopeId);
  const acting=(await query('SELECT Id,Active,BranchId,DepartmentId FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE EmployeeId=@employee',{employee:p.text(body.employeeId,40)})).recordset[0];
  requireCondition(acting?.Active&&acting.Id!==principal.Id,400,'INVALID_ACTING_USER','Choose a different active registered employee.');
  if(body.scopeId)requireCondition((body.role==='Branch manager'?acting.BranchId:acting.DepartmentId)===body.scopeId,400,'ACTING_USER_OUT_OF_SCOPE','An acting manager must belong to this branch; an acting head must belong to this department.');
  const params={principal:p.id(principal.Id),acting:p.id(acting.Id),role:p.text(body.role,40),scope:p.id(body.scopeId),start:p.date(start),end:p.date(end),actor:p.id(req.user.Id)};
  const overlapping=(await query(`SELECT Id FROM dbo.RoleDelegations WITH(UPDLOCK,HOLDLOCK) WHERE PrincipalId=@principal AND Role=@role
   AND (ScopeId=@scope OR (ScopeId IS NULL AND @scope IS NULL)) AND RevokedAt IS NULL AND StartsAt<@end AND EndsAt>@start`,params)).recordset;
  requireCondition(!overlapping.length,409,'ACTING_PERIOD_OVERLAP','This role already has an acting replacement during that period. End the existing assignment or select another time.');
  // Prevent cycles through several permanent global role holders.
  const cycle=(await query(`SELECT Id FROM dbo.RoleDelegations WITH(UPDLOCK,HOLDLOCK) WHERE (PrincipalId=@acting OR ActingUserId=@principal) AND Role=@role AND ScopeId IS NULL AND @scope IS NULL
   AND RevokedAt IS NULL AND StartsAt<@end AND EndsAt>@start`,params)).recordset;
  requireCondition(!cycle.length,409,'ACTING_CYCLE','An acting appointment cannot be delegated again or form a cycle.');
  const row=(await query('INSERT dbo.RoleDelegations(PrincipalId,ActingUserId,Role,ScopeId,StartsAt,EndsAt,CreatedBy) OUTPUT inserted.Id VALUES(@principal,@acting,@role,@scope,@start,@end,@actor)',params)).recordset[0];
  await bumpPending(query,principal.Id,body.role,body.scopeId);
  await audit(query,req,'role.acting_assigned',row.Id,{principalId:principal.Id,actingUserId:acting.Id,role:body.role,scopeId:body.scopeId,startsAt:body.startsAt,endsAt:body.endsAt});
  return {id:row.Id};
 });
}
export async function revokeDelegation(db,req,id,version){
 await db.transaction(async query=>{
  const row=(await query('SELECT * FROM dbo.RoleDelegations WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id',{id:p.id(id)})).recordset[0];
  requireCondition(row,404,'ACTING_ASSIGNMENT_NOT_FOUND');
  const principal=(await query('SELECT Id,Role,Active FROM dbo.Users WHERE Id=@id',{id:p.id(row.PrincipalId)})).recordset[0];
  // Administrators and the original principal can always end an appointment,
  // including after a permanent scope or role changes.
  requireCondition(isAdministrator(req.user)||req.user.Id===row.PrincipalId||row.ScopeId&&hasRole(req.user,'IT'),403,'DELEGATION_FORBIDDEN');
  requireCondition(row.Version.toString('hex')===version,409,'STALE_VERSION','This acting assignment changed. Reload before trying again.');
  requireCondition(!row.RevokedAt,409,'ACTING_ASSIGNMENT_ENDED');
  await query('UPDATE dbo.RoleDelegations SET RevokedAt=SYSUTCDATETIME(),RevokedBy=@actor WHERE Id=@id',{id:p.id(id),actor:p.id(req.user.Id)});
  await bumpPending(query,principal.Id,row.Role,row.ScopeId);await audit(query,req,'role.acting_ended',id,{principalId:row.PrincipalId,actingUserId:row.ActingUserId,role:row.Role,scopeId:row.ScopeId});
 });
}
export function delegationRoutes(db){
 const router=Router();
 router.get('/acting-assignments',async(req,res)=>{
  const all=hasRole(req.user,'IT','Admin','Super Admin');
  const result=await db.query(`SELECT d.*,CAST(CASE WHEN p.Active=1 AND a.Active=1 AND ((d.ScopeId IS NULL AND p.Role=d.Role) OR (EXISTS(SELECT 1 FROM dbo.OrganizationApprovers owner WHERE owner.ScopeId=d.ScopeId AND owner.UserId=d.PrincipalId) AND ((d.Role=N'Branch manager' AND a.BranchId=d.ScopeId) OR (d.Role=N'Department head' AND a.DepartmentId=d.ScopeId)))) THEN 1 ELSE 0 END AS bit) AS Valid,p.Name AS PrincipalName,p.EmployeeId AS PrincipalEmployeeId,a.Name AS ActingName,a.EmployeeId AS ActingEmployeeId,l.Name AS ScopeName
   FROM dbo.RoleDelegations d JOIN dbo.Users p ON p.Id=d.PrincipalId JOIN dbo.Users a ON a.Id=d.ActingUserId LEFT JOIN dbo.Lookups l ON l.Id=d.ScopeId
   WHERE d.PrincipalId=@actor OR d.ActingUserId=@actor OR @all=1 AND (d.ScopeId IS NOT NULL OR @admin=1)
   ORDER BY d.CreatedAt DESC`,{actor:p.id(req.user.Id),all:p.bit(all),admin:p.bit(isAdministrator(req.user))});
  res.json({items:result.recordset.map(row=>({...row,Version:row.Version.toString('hex')}))});
 });
 router.get('/acting-options',async(req,res)=>{
  const result=await db.query(`SELECT a.ScopeId,l.Kind,l.Name,u.Id AS PrincipalId,u.EmployeeId,u.Name AS PrincipalName,
   CASE WHEN l.Kind='branch' THEN N'Branch manager' ELSE N'Department head' END AS Role
   FROM dbo.OrganizationApprovers a JOIN dbo.Lookups l ON l.Id=a.ScopeId AND l.Active=1 JOIN dbo.Users u ON u.Id=a.UserId AND u.Active=1
   WHERE a.UserId=@actor OR @manage=1;
   SELECT u.Id AS PrincipalId,u.EmployeeId,u.Name AS PrincipalName,u.Role FROM dbo.Users u WHERE u.Active=1 AND u.Role IN ('IT','CITO') AND (u.Id=@actor OR @admin=1)`,{actor:p.id(req.user.Id),manage:p.bit(hasRole(req.user,'IT','Admin','Super Admin')),admin:p.bit(isAdministrator(req.user))});
  res.json({items:[...result.recordsets[0],...result.recordsets[1].map(row=>({...row,ScopeId:null,Name:row.Role}))]});
 });
 router.get('/acting-candidates',async(req,res)=>{
  const body=parse(delegationSchema.pick({principalId:true,role:true,scopeId:true}).extend({scopeId:id.optional()}),{principalId:req.query.principalId,role:req.query.role,scopeId:req.query.scopeId});
  const principal=(await db.query('SELECT Id,Role,Active FROM dbo.Users WHERE Id=@id',{id:p.id(body.principalId)})).recordset[0];requireCondition(principal?.Active,400,'INVALID_PRINCIPAL');
  await requireAuthority(db.query,req.user,principal,body.role,body.scopeId||null);
  const filter=parse(z.object({search:text(40)}),{search:req.query.search});
  const result=await db.query(`SELECT TOP(20) Id,EmployeeId,Name,BranchId,DepartmentId FROM dbo.Users WHERE Active=1 AND Id<>@principal AND EmployeeId=@employee
   AND (@scope IS NULL OR (@role=N'Branch manager' AND BranchId=@scope) OR (@role=N'Department head' AND DepartmentId=@scope))`,{principal:p.id(body.principalId),employee:p.text(filter.search,40),scope:p.id(body.scopeId),role:p.text(body.role,40)});
  res.json({items:result.recordset});
 });
 router.post('/acting-assignments',recentAuth,async(req,res)=>res.status(201).json(await createDelegation(db,req,parse(delegationSchema,req.body))));
 router.post('/acting-assignments/:id/end',recentAuth,async(req,res)=>{const {version}=parse(z.object({version:z.string().regex(/^[a-f0-9]{16}$/i).transform(value=>value.toLowerCase())}).strict(),req.body);await revokeDelegation(db,req,uuidParam(req),version);res.status(204).end();});
 return router;
}
