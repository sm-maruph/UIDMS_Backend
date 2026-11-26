import {p} from '../../core/db.js';
import {notify} from '../audit/service.js';

// Called inside the transaction that advances the request. Authority comes from the
// same SQL functions used by review authorization, including scoped acting cover.
export async function notifyAttention(query,requestId){
 const result=await query(`SELECT DISTINCT u.Id,r.TicketNumber,
  CASE WHEN r.Status='Employee review' THEN N'employee access review required'
   WHEN r.Status='Approved' THEN N'processing required'
   WHEN EXISTS(SELECT 1 FROM dbo.RequestSteps later WHERE later.RequestId=r.Id AND later.Position>r.CurrentPosition) THEN N'recommendation required'
   ELSE N'approval required' END AS Attention
  FROM dbo.Requests r JOIN dbo.Users u ON u.Active=1
  WHERE r.Id=@id AND r.DeletedAt IS NULL AND (
   (r.Status='Employee review' AND u.Id=r.SubjectUserId)
   OR (r.Status IN ('Pending','In review') AND u.Id<>r.RequesterId AND (r.SubjectUserId IS NULL OR u.Id<>r.SubjectUserId)
    AND EXISTS(SELECT 1 FROM dbo.RequestSteps s CROSS APPLY dbo.uidms_StepReviewers(s.RequestId,s.Position) eligible WHERE s.RequestId=r.Id AND s.Position=r.CurrentPosition AND s.Status='Waiting' AND eligible.UserId=u.Id))
   OR (r.Status='Approved' AND EXISTS(SELECT 1 FROM dbo.uidms_EffectiveRoles(u.Id) er WHERE er.Role='IT'))
  )`,{id:p.id(requestId)});
 for(const user of result.recordset)await notify(query,user.Id,requestId,`${user.TicketNumber}: ${user.Attention}.`);
}
