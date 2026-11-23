import {p} from '../../core/db.js';
export async function queryParticipants(query,ticket,actorId){
 return (await query(`SELECT u.Id,u.EmployeeId,u.Name,u.Role FROM dbo.Users u WHERE u.Active=1 AND u.Id<>@actor
  AND (u.Id=@requester OR u.Id=@subject OR EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=@request AND s.Position<@position
   AND (s.ActorId=u.Id OR s.AssignedUserId=u.Id OR EXISTS(SELECT 1 FROM dbo.uidms_StepReviewers(s.RequestId,s.Position) eligible WHERE eligible.UserId=u.Id)))
   OR (u.Role='HR' AND EXISTS(SELECT 1 FROM dbo.RequestSteps s WHERE s.RequestId=@request AND s.Role='HR')))
  ORDER BY u.Name,u.EmployeeId`,{actor:p.id(actorId),requester:p.id(ticket.RequesterId),subject:p.id(ticket.SubjectUserId),request:p.id(ticket.Id),position:p.int(ticket.CurrentPosition)})).recordset;
}
