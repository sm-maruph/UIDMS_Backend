import {routingNameSql} from '../directory/organization-names.js';
import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {resolveManager} from '../directory/approvers.js';
import {managerRole} from '../requests/policy.js';

export async function newUserCustodian(query,ticket){
 const approved=(await query("SELECT TOP(1) ActorId FROM dbo.RequestSteps WHERE RequestId=@id AND Role IN ('Branch manager','Department head') AND Status='Approved' ORDER BY Position",{id:p.id(ticket.Id)})).recordset[0]?.ActorId;
 if(approved)return approved;
 // A configurable workflow can omit manager approval; custody still belongs to
 // the scoped manager/head, never an arbitrary reviewer or the IT operator.
 const scope=(await query(`SELECT b.Name AS Branch,d.Name AS Department,${routingNameSql('b')} AS RoutingBranch,${routingNameSql('d')} AS RoutingDepartment FROM dbo.Lookups b CROSS JOIN dbo.Lookups d WHERE b.Id=@branch AND d.Id=@department`,{branch:p.id(ticket.BranchId),department:p.id(ticket.DepartmentId)})).recordset[0];
 requireCondition(scope,409,'CUSTODIAN_REQUIRED','The request needs a valid branch and department for credential custody.');
 const role=managerRole(scope.RoutingBranch||scope.Branch,scope.RoutingDepartment||scope.Department);
 const principal=await resolveManager(query,role,ticket.BranchId,ticket.DepartmentId);
 const acting=(await query(`SELECT TOP(1) d.ActingUserId FROM dbo.RoleDelegations d JOIN dbo.Users u ON u.Id=d.ActingUserId AND u.Active=1
  WHERE d.PrincipalId=@principal AND d.Role=@role AND d.ScopeId=@scope AND d.RevokedAt IS NULL AND d.StartsAt<=SYSUTCDATETIME() AND d.EndsAt>SYSUTCDATETIME()`,{principal:p.id(principal),role:p.text(role,40),scope:p.id(role==='Branch manager'?ticket.BranchId:ticket.DepartmentId)})).recordset[0];
 return acting?.ActingUserId||principal;
}
