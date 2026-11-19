import {p} from '../../core/db.js';
import {visibility,actorParams} from './policy.js';
import {requireCondition} from '../../core/errors.js';
export async function loadTicket(query,id,user,{lock=false}={}){
 const result=await query(`SELECT r.*,rt.Name AS Action,u.Name AS RequesterName,u.EmployeeId, b.Name AS Branch,d.Name AS Department FROM dbo.Requests r ${lock?'WITH(UPDLOCK,HOLDLOCK)':''} JOIN dbo.RequestTypes rt ON rt.Code=r.TypeCode JOIN dbo.Users u ON u.Id=r.RequesterId JOIN dbo.Lookups b ON b.Id=r.BranchId JOIN dbo.Lookups d ON d.Id=r.DepartmentId WHERE r.Id=@id AND ${visibility}`,{id:p.id(id),...actorParams(user)});
 requireCondition(result.recordset.length,404,'REQUEST_NOT_FOUND');return result.recordset[0];
}
export async function currentStep(query,ticket){return (await query('SELECT * FROM dbo.RequestSteps WHERE RequestId=@id AND Position=@position',{id:p.id(ticket.Id),position:p.int(ticket.CurrentPosition)})).recordset[0];}
export const ticketSummary=row=>({id:row.Id,ticketNumber:row.TicketNumber,typeCode:row.TypeCode,action:row.Action,name:row.RequesterName,requesterId:row.EmployeeId,requesterUserId:row.RequesterId,subjectUserId:row.SubjectUserId,branch:row.Branch,department:row.Department,state:row.Status,assignedRole:row.AssignedRole||null,currentPosition:row.CurrentPosition,justification:row.Justification,createdAt:row.CreatedAt,updatedAt:row.UpdatedAt,version:row.Version.toString('hex'),...(row.Details?{demoRecord:JSON.parse(row.Details).mockSource}:{} )});
export async function details(query,ticket,user){
 const parameters={id:p.id(ticket.Id)};
 const result=await query(`SELECT rp.*,u.EmployeeId AS ExistingEmployeeId FROM dbo.RequestPeople rp LEFT JOIN dbo.Users u ON u.Id=rp.UserId WHERE rp.RequestId=@id;
 SELECT ri.*,s.Name AS SystemName,sr.Name AS RoleName FROM dbo.RequestItems ri JOIN dbo.Systems s ON s.Id=ri.SystemId LEFT JOIN dbo.SystemRoles sr ON sr.Id=ri.SystemRoleId WHERE ri.RequestId=@id;
 SELECT rs.*,u.Name AS ActorName FROM dbo.RequestSteps rs LEFT JOIN dbo.Users u ON u.Id=rs.ActorId WHERE rs.RequestId=@id ORDER BY rs.Position;
 SELECT q.*,a.Name AS AuthorName,a.Role AS AuthorRole,a.EmployeeId AS AuthorEmployeeId,b.Name AS RecipientName,b.EmployeeId AS RecipientEmployeeId,qr.Message AS Response,qr.CreatedAt AS ResponseAt FROM dbo.Queries q JOIN dbo.Users a ON a.Id=q.AuthorId JOIN dbo.Users b ON b.Id=q.RecipientId LEFT JOIN dbo.QueryResponses qr ON qr.QueryId=q.Id WHERE q.RequestId=@id ORDER BY q.CreatedAt;
 SELECT f.*,u.Name AS ActorName FROM dbo.Fulfilments f JOIN dbo.Users u ON u.Id=f.ActorId WHERE f.RequestId=@id;
 SELECT Id,OriginalName,ContentType,Sha256,ScanStatus,CreatedAt FROM dbo.Attachments WHERE RequestId=@id;
 SELECT h.* FROM dbo.HrClearances h JOIN dbo.RequestPeople rp ON rp.Id=h.PersonId WHERE rp.RequestId=@id`,parameters);
 const [people,items,steps,queries,fulfilment,attachments,hrClearance]=result.recordsets;
 const current=steps.find(step=>step.Position===ticket.CurrentPosition);
 return {...ticketSummary({...ticket,AssignedRole:current?.Role}),details:JSON.parse(ticket.Details),requesterProfile:JSON.parse(ticket.RequesterSnapshot),signatureBase64:ticket.SignatureSnapshot?.toString('base64')||null,
  people:people.map(person=>({id:person.Id,userId:person.UserId,employeeId:person.EmployeeId,name:person.Name,branchId:person.BranchId,departmentId:person.DepartmentId,details:JSON.parse(person.Details)})),
  items:items.map(item=>({id:item.Id,personId:item.PersonId,systemId:item.SystemId,system:item.SystemName,systemRoleId:item.SystemRoleId,role:item.RoleName,operation:item.Operation,reason:item.Reason})),
  approvalHistory:steps.map(step=>({position:step.Position,role:step.Role,status:step.Status,actorId:step.ActorId,by:step.ActorName,remark:step.Remark,at:step.DecidedAt})),
  queries:queries.map(row=>({id:row.Id,authorId:row.AuthorId,authorEmployeeId:row.AuthorEmployeeId,by:row.AuthorName,role:row.AuthorRole,recipientId:row.RecipientId,recipientEmployeeId:row.RecipientEmployeeId,recipient:row.RecipientName,message:row.Message,at:row.CreatedAt,response:row.Response,responseAt:row.ResponseAt,resolvedAt:row.ResolvedAt})),fulfilment:fulfilment[0]||null,attachments,hrClearance};
}
