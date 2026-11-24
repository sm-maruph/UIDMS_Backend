import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,text,parse,uuidParam} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {roles,recentAuth} from '../auth/service.js';
import {hasRole} from '../auth/authorization.js';
import {audit} from '../audit/service.js';

export const assignmentSchema=z.object({employeeId:text(40).regex(/^[A-Za-z0-9_-]+$/),version:z.string().regex(/^[a-f0-9]{16}$/i).nullable()}).strict();
export async function resolveManager(query,role,branchId,departmentId){
 const scope=role==='Branch manager'?branchId:departmentId;
 const assigned=(await query('SELECT a.UserId,u.Active FROM dbo.OrganizationApprovers a WITH(HOLDLOCK) JOIN dbo.Users u ON u.Id=a.UserId WHERE a.ScopeId=@scope',{scope:p.id(scope)})).recordset;
 if(assigned.length){requireCondition(assigned[0].Active,409,'APPROVER_INACTIVE','The assigned manager is inactive. Ask IT to update the approver assignment.');return assigned[0].UserId;}
 const legacy=(await query("SELECT Id FROM dbo.Users WHERE Active=1 AND Role=@role AND ((@role=N'Branch manager' AND BranchId=@branch) OR (@role=N'Department head' AND DepartmentId=@department))",{role:p.text(role,40),branch:p.id(branchId),department:p.id(departmentId)})).recordset;
 requireCondition(legacy.length===1,409,'APPROVER_REQUIRED',legacy.length?'Multiple active legacy managers match this scope. IT, Admin or Super Admin must select its assigned manager in Approver assignments.':'No active manager is assigned to this exact branch or department. IT, Admin or Super Admin must assign its manager in Approver assignments.');
 return legacy[0].Id;
}
export async function saveAssignment(db,req,scopeId,body){
 requireCondition(hasRole(req.user,'IT','Admin','Super Admin'),403,'FORBIDDEN');
 return db.transaction(async query=>{
  // Lock the scope before its mapping: concurrent first assignments serialize too.
  const scope=(await query("SELECT Id,Kind FROM dbo.Lookups WITH(UPDLOCK,HOLDLOCK) WHERE Id=@scope AND Active=1 AND Kind IN ('branch','department')",{scope:p.id(scopeId)})).recordset[0];
  requireCondition(scope,404,'SCOPE_NOT_FOUND','Choose an active department or branch.');
  const previous=(await query('SELECT UserId,Version FROM dbo.OrganizationApprovers WITH(UPDLOCK,HOLDLOCK) WHERE ScopeId=@scope',{scope:p.id(scopeId)})).recordset[0];
  requireCondition((previous?.Version.toString('hex')||null)===(body.version?.toLowerCase()||null),409,'STALE_ASSIGNMENT','This assignment changed. Reload before saving again.');
  const user=(await query('SELECT Id FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE EmployeeId=@employee AND Active=1',{employee:p.text(body.employeeId,40)})).recordset[0];
  requireCondition(user,400,'ASSIGNEE_NOT_FOUND','Enter the system ID of an active registered UIDMS user.');
  const params={scope:p.id(scopeId),user:p.id(user.Id),actor:p.id(req.user.Id),role:p.text(scope.Kind==='branch'?'Branch manager':'Department head',40)};
  await query(previous?'UPDATE dbo.OrganizationApprovers SET UserId=@user,UpdatedBy=@actor,UpdatedAt=SYSUTCDATETIME() WHERE ScopeId=@scope':'INSERT dbo.OrganizationApprovers(ScopeId,UserId,UpdatedBy) VALUES(@scope,@user,@actor)',params);
  const result=await query(`DECLARE @affected TABLE(Id uniqueidentifier PRIMARY KEY);
   UPDATE r SET UpdatedAt=SYSUTCDATETIME() OUTPUT inserted.Id INTO @affected
   FROM dbo.Requests r WITH(UPDLOCK,HOLDLOCK) WHERE r.DeletedAt IS NULL AND r.Status IN ('Employee review','Pending','In review','Query')
   AND EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=r.Id AND s.Status='Waiting' AND s.Role=@role
    AND ((@role=N'Branch manager' AND s.BranchId=@scope) OR (@role=N'Department head' AND s.DepartmentId=@scope)));
   UPDATE s SET AssignedUserId=@user FROM dbo.RequestSteps s JOIN @affected r ON r.Id=s.RequestId
   WHERE s.Status='Waiting' AND s.Role=@role AND ((@role=N'Branch manager' AND s.BranchId=@scope) OR (@role=N'Department head' AND s.DepartmentId=@scope));
   SELECT COUNT(*) AS UpdatedRequests FROM @affected;`,params);
  const updatedRequests=result.recordset[0].UpdatedRequests;
  await query('UPDATE dbo.RoleDelegations SET RevokedAt=SYSUTCDATETIME(),RevokedBy=@actor WHERE ScopeId=@scope AND PrincipalId<>@user AND RevokedAt IS NULL',params);
  await audit(query,req,'organization.approver_assigned',scopeId,{previousUserId:previous?.UserId||null,userId:user.Id,kind:scope.Kind,updatedRequests});
  return {updatedRequests};
 });
}
export function approverRoutes(db){
 const router=Router();
 router.get('/approver-assignments',roles('IT','Admin','Super Admin'),async(req,res)=>{
  const result=await db.query(`SELECT l.Id AS ScopeId,l.Kind,l.Name,a.UserId,u.EmployeeId,u.Name AS UserName,u.Active,a.Version
   FROM dbo.Lookups l LEFT JOIN dbo.OrganizationApprovers a ON a.ScopeId=l.Id LEFT JOIN dbo.Users u ON u.Id=a.UserId
   WHERE l.Active=1 AND l.Kind IN ('branch','department') ORDER BY l.Kind,l.Name`);
  res.json({items:result.recordset.map(row=>({...row,Version:row.Version?.toString('hex')||null}))});
 });
 router.put('/approver-assignments/:id',roles('IT','Admin','Super Admin'),recentAuth,async(req,res)=>res.json(await saveAssignment(db,req,uuidParam(req),parse(assignmentSchema,req.body))));
 return router;
}
