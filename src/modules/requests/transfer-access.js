import {createHash} from 'node:crypto';
import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';

export const accessKey=row=>`${row.systemId}:${row.systemRoleId||''}`;
export const inventoryVersion=rows=>createHash('sha256').update(JSON.stringify(rows.map(accessKey).sort())).digest('hex');
export function assertTransferReviewed(ticket){
 if(ticket.TypeCode!=='movement')return;
 const review=JSON.parse(ticket.Details||'{}').transferAccess;
 requireCondition(!(review?.version===1&&review.employeeDifference?.added?.length&&!review.itReview),409,'TRANSFER_IT_REVIEW_REQUIRED','New destination access must be reviewed by IT before final approval or completion.');
}
export async function currentTransferAccess(query,userId){
 const rows=(await query(`SELECT DISTINCT g.SystemId AS systemId,s.Name AS system,g.SystemRoleId AS systemRoleId,sr.Name AS role
  FROM dbo.AccessGrants g JOIN dbo.Systems s ON s.Id=g.SystemId LEFT JOIN dbo.SystemRoles sr ON sr.Id=g.SystemRoleId
  WHERE g.UserId=@user AND g.RevokedAt IS NULL ORDER BY s.Name,sr.Name`,{user:p.id(userId)})).recordset;
 return {rows,inventoryVersion:inventoryVersion(rows)};
}
export async function transferCatalogue(query){
 const result=await query(`SELECT Id,Name,Active FROM dbo.Systems ORDER BY Name; SELECT Id,SystemId,Name,Active FROM dbo.SystemRoles ORDER BY Name`);
 return result.recordsets[0].map(system=>({id:system.Id,name:system.Name,active:system.Active,roles:result.recordsets[1].filter(role=>role.SystemId===system.Id).map(role=>({id:role.Id,name:role.Name,active:role.Active}))}));
}
export async function transferReview(query,ticket,inventory){
 const saved=JSON.parse(ticket.Details).transferAccess;if(saved?.version===1)return saved;
 if(ticket.Status==='Employee review')return null;
 // Older requests did not capture explicit confirmation. Preserve their selected
 // access and the services the old transfer flow automatically retained. Label
 // this reconstruction honestly rather than inventing an employee confirmation.
 const recorded=(await query(`SELECT i.SystemId AS systemId,s.Name AS system,i.SystemRoleId AS systemRoleId,sr.Name AS role,i.Reason AS reason FROM dbo.RequestItems i JOIN dbo.Systems s ON s.Id=i.SystemId LEFT JOIN dbo.SystemRoles sr ON sr.Id=i.SystemRoleId WHERE i.RequestId=@id AND i.Operation<>'revoke'`,{id:p.id(ticket.Id)})).recordset;
 const unmanaged=(await query('SELECT Id FROM dbo.Systems WHERE TransferManaged=0')).recordset.map(row=>row.Id);
 const selectedSystems=new Set(recorded.map(row=>row.systemId));
 const selection=[...recorded,...inventory.rows.filter(row=>unmanaged.includes(row.systemId)&&!selectedSystems.has(row.systemId)).map(row=>({...row,reason:'Existing access retained by the previous transfer flow'}))];
 return {version:1,legacy:true,current:inventory.rows,inventoryVersion:inventory.inventoryVersion,employeeSelection:selection,employeeDifference:transferDifference(inventory.rows,selection),employeeConfirmed:false,itReview:null};
}
export function transferDifference(current,selection){
 const old=new Set(current.map(accessKey)),next=new Set(selection.map(accessKey));
 return {kept:selection.filter(row=>old.has(accessKey(row))),added:selection.filter(row=>!old.has(accessKey(row))),removed:current.filter(row=>!next.has(accessKey(row)))};
}
export async function applyTransferAccess(query,ticket,review,credentials){
 const selection=review.itReview?.selection||review.employeeSelection,difference=transferDifference(review.current,selection);
 for(const row of difference.removed)await query('UPDATE dbo.AccessGrants SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@user AND SystemId=@system AND (SystemRoleId=@role OR (SystemRoleId IS NULL AND @role IS NULL)) AND RevokedAt IS NULL',{user:p.id(ticket.SubjectUserId),system:p.id(row.systemId),role:p.id(row.systemRoleId)});
 for(const row of difference.added)await query('INSERT dbo.AccessGrants(UserId,SystemId,SystemRoleId,Username,SourceRequestId) VALUES(@user,@system,@role,@username,@request)',{user:p.id(ticket.SubjectUserId),system:p.id(row.systemId),role:p.id(row.systemRoleId),username:p.text(credentials.find(item=>item.systemId===row.systemId)?.username,150),request:p.id(ticket.Id)});
}
export async function canonicalSelection(query,items,current){
 const catalogue=await transferCatalogue(query),existing=new Set(current.map(accessKey)),seen=new Set();
 return items.map(item=>{
  const key=accessKey(item),system=catalogue.find(row=>row.id===item.systemId),role=system?.roles.find(row=>row.id===item.systemRoleId);
  requireCondition(!seen.has(key),400,'DUPLICATE_REQUEST_ITEM');seen.add(key);
  requireCondition(system&&(existing.has(key)||(system.active&&(!item.systemRoleId||role?.active))),400,'INVALID_SYSTEM_ROLE');
  requireCondition(existing.has(key)||!system.roles.some(row=>row.active)||role,400,'SYSTEM_ROLE_REQUIRED');
  return {systemId:system.id,system:system.name,systemRoleId:item.systemRoleId||null,role:role?.name||'',reason:item.reason};
 });
}
export async function replaceTransferItems(query,ticket,current,selection){
 const person=(await query('SELECT Id FROM dbo.RequestPeople WHERE RequestId=@id',{id:p.id(ticket.Id)})).recordset[0];
 requireCondition(person,409,'TRANSFER_PERSON_REQUIRED');
 await query('DELETE dbo.RequestItems WHERE RequestId=@id',{id:p.id(ticket.Id)});
 const targets=new Set(selection.map(row=>row.systemId));
 const removed=[...new Map(current.filter(row=>!targets.has(row.systemId)).map(row=>[row.systemId,{...row,systemRoleId:null,reason:'Remove access after transfer'}])).values()];
 for(const row of [...selection.map(row=>({...row,operation:'update'})),...removed.map(row=>({...row,operation:'revoke'}))])await query('INSERT dbo.RequestItems(RequestId,PersonId,SystemId,SystemRoleId,Operation,Reason) VALUES(@request,@person,@system,@role,@operation,@reason)',{request:p.id(ticket.Id),person:p.id(person.Id),system:p.id(row.systemId),role:p.id(row.systemRoleId),operation:p.str(row.operation,20),reason:p.text(row.reason,2000)});
}
export async function saveEmployeeTransferAccess(query,req,ticket,body){
 requireCondition(body.confirmedCurrentAccess===true,400,'TRANSFER_CONFIRMATION_REQUIRED','Confirm which current systems you still need after the transfer.');
 const inventory=await currentTransferAccess(query,ticket.SubjectUserId);
 requireCondition(body.inventoryVersion===inventory.inventoryVersion,409,'TRANSFER_ACCESS_CHANGED','Your current access changed. Reopen the review to load the latest access.');
 const selection=await canonicalSelection(query,body.items,inventory.rows),difference=transferDifference(inventory.rows,selection);
 if(difference.added.length){const it=await query("SELECT 1 AS Found FROM dbo.RequestSteps WHERE RequestId=@id AND Role='IT' AND Status='Waiting'",{id:p.id(ticket.Id)});requireCondition(it.recordset.length,409,'TRANSFER_IT_STEP_REQUIRED','New access requires an IT review step. Ask an administrator to include IT in this transfer workflow.');}
 const previous=JSON.parse(ticket.Details),at=new Date().toISOString();
 const details={...previous,transferChange:{...previous.transferChange,stage:'approval',employeeJustification:body.justification,accessConfirmedAt:at},transferAccess:{version:1,current:inventory.rows,inventoryVersion:inventory.inventoryVersion,employeeSelection:selection,employeeDifference:difference,employeeConfirmed:true,employeeReviewedAt:at,employeeName:req.user.Name,itReview:null}};
 await query('INSERT dbo.RequestRevisions(RequestId,ActorId,Snapshot) VALUES(@id,@actor,@snapshot)',{id:p.id(ticket.Id),actor:p.id(req.user.Id),snapshot:p.json({details:previous,justification:ticket.Justification})});
 await replaceTransferItems(query,ticket,inventory.rows,selection);
 return details;
}
export async function saveItTransferAccess(query,req,ticket,body){
 const details=JSON.parse(ticket.Details),review=await transferReview(query,ticket,await currentTransferAccess(query,ticket.SubjectUserId));
 requireCondition(review?.version===1&&(review.employeeConfirmed||review.legacy),409,'TRANSFER_EMPLOYEE_REVIEW_REQUIRED','The employee must confirm destination access first.');
 const selection=await canonicalSelection(query,body.items,review.current),requested=new Set(review.employeeSelection.map(accessKey));
 requireCondition(selection.every(row=>requested.has(accessKey(row))),400,'TRANSFER_UNREQUESTED_ACCESS','IT may retain or remove requested access; extra access must be requested by the employee.');
 const itReview={selection,notes:body.notes,at:new Date().toISOString(),by:req.user.Name,employeeId:req.user.EmployeeId,removedByIT:review.employeeSelection.filter(row=>!selection.some(chosen=>accessKey(chosen)===accessKey(row))),difference:transferDifference(review.current,selection)};
 await query('INSERT dbo.RequestRevisions(RequestId,ActorId,Snapshot) VALUES(@id,@actor,@snapshot)',{id:p.id(ticket.Id),actor:p.id(req.user.Id),snapshot:p.json({details})});
 await replaceTransferItems(query,ticket,review.current,selection);
 const updated={...details,transferAccess:{...review,itReview}};
 await query('UPDATE dbo.Requests SET Details=@details,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',{id:p.id(ticket.Id),details:p.json(updated)});
 await audit(query,req,'movement.it_access_reviewed',ticket.Id,{removed:itReview.removedByIT,notes:body.notes});
}
