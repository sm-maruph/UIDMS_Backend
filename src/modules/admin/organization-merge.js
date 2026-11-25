import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';

// Runs inside the caller's serializable deletion transaction. Only unfinished
// requests move. Submitted snapshots and decided steps remain historical.
export async function mergePendingOrganization(query,req,kind,sourceId,replacementId){
 const params={source:p.id(sourceId),replacement:p.id(replacementId),actor:p.id(req.user.Id),kind:p.str(kind,20)};
 const acting=(await query('SELECT Id FROM dbo.RoleDelegations WHERE ScopeId=@source AND RevokedAt IS NULL AND EndsAt>SYSUTCDATETIME()',params)).recordset;
 requireCondition(!acting.length,409,'MERGE_ACTING_APPOINTMENTS','The old organization has scheduled or active acting appointments. End or reassign those appointments before merging; no records have been changed.');
 const retiredAssignment=(await query('SELECT ScopeId,UserId FROM dbo.OrganizationApprovers WHERE ScopeId=@source',params)).recordset[0]||null;
 const result=await query(`DECLARE @affected TABLE(Id uniqueidentifier PRIMARY KEY);
  INSERT @affected SELECT r.Id FROM dbo.Requests r
  WHERE r.DeletedAt IS NULL AND r.Status NOT IN ('Completed','Rejected','Cancelled') AND
  (r.BranchId=@source OR r.DepartmentId=@source OR r.DestinationBranchId=@source OR r.DestinationDepartmentId=@source
   OR EXISTS(SELECT 1 FROM dbo.RequestPeople rp WHERE rp.RequestId=r.Id AND (rp.BranchId=@source OR rp.DepartmentId=@source))
   OR EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=r.Id AND s.Status='Waiting' AND (s.BranchId=@source OR s.DepartmentId=@source)));
  INSERT dbo.RequestRevisions(RequestId,ActorId,Snapshot)
  SELECT r.Id,@actor,(SELECT 'organization_merged' AS reason,@source AS sourceId,@replacement AS replacementId,
   r.BranchId AS branchId,r.DepartmentId AS departmentId,r.DestinationBranchId AS destinationBranchId,r.DestinationDepartmentId AS destinationDepartmentId,
   JSON_QUERY((SELECT s.Position,s.Role,s.BranchId,s.DepartmentId,s.AssignedUserId FROM dbo.RequestSteps s WHERE s.RequestId=r.Id AND s.Status='Waiting' ORDER BY s.Position FOR JSON PATH)) AS pendingSteps
   FOR JSON PATH,WITHOUT_ARRAY_WRAPPER) FROM dbo.Requests r JOIN @affected changed ON changed.Id=r.Id;
  UPDATE r SET BranchId=CASE WHEN BranchId=@source THEN @replacement ELSE BranchId END,
   DepartmentId=CASE WHEN DepartmentId=@source THEN @replacement ELSE DepartmentId END,
   DestinationBranchId=CASE WHEN DestinationBranchId=@source THEN @replacement ELSE DestinationBranchId END,
   DestinationDepartmentId=CASE WHEN DestinationDepartmentId=@source THEN @replacement ELSE DestinationDepartmentId END,
   UpdatedAt=SYSUTCDATETIME()
   FROM dbo.Requests r JOIN @affected changed ON changed.Id=r.Id;
  UPDATE rp SET BranchId=CASE WHEN rp.BranchId=@source THEN @replacement ELSE rp.BranchId END,
   DepartmentId=CASE WHEN rp.DepartmentId=@source THEN @replacement ELSE rp.DepartmentId END
   FROM dbo.RequestPeople rp JOIN @affected changed ON changed.Id=rp.RequestId;
  UPDATE s SET BranchId=CASE WHEN s.BranchId=@source THEN @replacement ELSE s.BranchId END,
   DepartmentId=CASE WHEN s.DepartmentId=@source THEN @replacement ELSE s.DepartmentId END
   FROM dbo.RequestSteps s JOIN @affected changed ON changed.Id=s.RequestId WHERE s.Status='Waiting';
  SELECT r.Id,r.TicketNumber FROM dbo.Requests r JOIN @affected changed ON changed.Id=r.Id ORDER BY r.Id;
  SELECT TOP(10) r.TicketNumber,s.Position,s.Role FROM dbo.RequestSteps s JOIN @affected changed ON changed.Id=s.RequestId
   JOIN dbo.Requests r ON r.Id=s.RequestId
   WHERE s.Status='Waiting' AND s.Role IN ('Manager','Branch manager','Department head')
   AND NOT EXISTS(SELECT 1 FROM dbo.uidms_StepReviewers(s.RequestId,s.Position));`,params);
 const conflicts=result.recordsets[1]||[];
 requireCondition(!conflicts.length,409,'MERGE_APPROVER_REQUIRED',`The merge would leave pending steps without an eligible reviewer: ${conflicts.map(row=>`${row.TicketNumber} (${row.Role})`).join(', ')}. Set their approver/workflow first, then reload the review. No records have been changed.`);
 const changed=result.recordsets[0]||[];
 // A single set-based audit insert preserves an event for every affected ticket.
 if(changed.length)await query(`INSERT dbo.AuditEvents(ActorId,Event,EntityId,Ip,CorrelationId,Metadata,AuditSessionId,ActorRole)
  SELECT @actor,'request.organization_merged',CONVERT(nvarchar(80),Id),@ip,@correlation,
   (SELECT @kind AS kind,@source AS sourceId,@replacement AS replacementId,TicketNumber AS ticketNumber FOR JSON PATH,WITHOUT_ARRAY_WRAPPER),@session,@role
  FROM OPENJSON(@rows) WITH(Id uniqueidentifier,TicketNumber nvarchar(40))`,{...params,ip:p.str(req.ip||'local',64),correlation:p.id(req.id),session:p.id(req.auditSessionId),role:p.text(req.user.Role,40),rows:p.json(changed)});
 await audit(query,req,'organization.merged',sourceId,{kind,replacementId,updatedRequests:changed.length,pendingApprovers:'preserved',completedDecisions:'preserved',retiredAssignment});
 return changed.length;
}
