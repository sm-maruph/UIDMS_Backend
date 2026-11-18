import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,id,text,parse,uuidParam} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {seal,unseal} from '../../core/crypto.js';
import {loadTicket} from '../requests/repository.js';
import {assertVersion} from '../requests/policy.js';
import {version} from '../requests/schemas.js';
import {roles,recentAuth} from '../auth/service.js';
import {audit,notify} from '../audit/service.js';
import {createEmailDrafts,readEmailDrafts,emailFields} from './system-email.js';

const processingStates=['Approved','IT processing','HO processing'];
const sentDraft=z.object({confirmedSent:z.literal(true),email:emailFields.extend({body:text(200000)}).strict().optional()}).strict();

async function requireEmailDraftsSent(query,requestId){
 const {recordset}=await query(`SELECT TOP (1) Id FROM dbo.RequestEmailDrafts
  WHERE RequestId=@id AND SentAt IS NULL AND EXISTS(SELECT 1 FROM dbo.RequestEmailDrafts WHERE RequestId=@id AND TemplateId IS NOT NULL)`,{id:p.id(requestId)});
 requireCondition(!recordset.length,409,'EMAIL_DRAFTS_PENDING','Confirm each processing email was sent before continuing.');
}

export function fulfilmentRoutes(db,config){
 const router=Router();
 router.get('/requests/:id/email-drafts',roles('IT'),async(req,res)=>{
  const requestId=uuidParam(req);
  const ticket=await loadTicket(db.query,requestId,req.user);
  requireCondition([...processingStates,'Completed'].includes(ticket.Status),409,'FINAL_APPROVAL_REQUIRED');
  res.json({items:await readEmailDrafts(db.query,requestId)});
 });
 // Initialize drafts for tickets approved before this feature was installed.
 router.post('/requests/:id/email-drafts',roles('IT'),async(req,res)=>{
  const requestId=uuidParam(req);
  const items=await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});
   requireCondition(ticket.Status==='Approved',409,'FINAL_APPROVAL_REQUIRED');
   requireCondition(ticket.RequesterId!==req.user.Id&&ticket.SubjectUserId!==req.user.Id,403,'SEPARATION_OF_DUTIES');
   const drafts=await readEmailDrafts(query,requestId);
   if(drafts.length)return drafts;
   await createEmailDrafts(query,ticket);
   return readEmailDrafts(query,requestId);
  });
  res.json({items});
 });
 router.post('/requests/:id/email-drafts/:draftId/sent',roles('IT'),async(req,res)=>{
  const requestId=uuidParam(req),draftId=uuidParam(req,'draftId'),body=parse(sentDraft,req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});
   requireCondition(processingStates.includes(ticket.Status),409,'FINAL_APPROVAL_REQUIRED');
   requireCondition(ticket.RequesterId!==req.user.Id&&ticket.SubjectUserId!==req.user.Id,403,'SEPARATION_OF_DUTIES');
   const params={request:p.id(requestId),draft:p.id(draftId)};
   const row=(await query('SELECT Content,SentAt FROM dbo.RequestEmailDrafts WHERE Id=@draft AND RequestId=@request',params)).recordset[0];
   requireCondition(row,404,'DRAFT_NOT_FOUND');
   if(row.SentAt)return;
   const content={...JSON.parse(row.Content),...body.email};
   requireCondition(content.to.length&&content.subject.trim()&&content.body.trim(),400,'INCOMPLETE_EMAIL','Enter a recipient, subject and body for this draft.');
   await query('UPDATE dbo.RequestEmailDrafts SET Content=@content,SentBy=@actor,SentAt=SYSUTCDATETIME() WHERE Id=@draft AND RequestId=@request',{...params,content:p.json(content),actor:p.id(req.user.Id)});
   await audit(query,req,'fulfilment.email_marked_sent',requestId,{draftId});
  });
  res.status(204).end();
 });
 router.post('/requests/:id/processing',roles('IT'),async(req,res)=>{
  const requestId=uuidParam(req),body=parse(z.object({version,reference:text(250),notes:text(2000,0).default('')}).strict(),req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);requireCondition(['Approved','IT processing'].includes(ticket.Status),409,'NOT_READY_FOR_PROCESSING');
   requireCondition(ticket.RequesterId!==req.user.Id,403,'SEPARATION_OF_DUTIES');
   await requireEmailDraftsSent(query,requestId);
   await query('UPDATE dbo.Fulfilments SET ActorId=@actor,ProcessingReference=@reference,Notes=@notes,ProcessingAt=SYSUTCDATETIME() WHERE RequestId=@id; IF @@ROWCOUNT=0 INSERT dbo.Fulfilments(RequestId,ActorId,ProcessingReference,Notes,ProcessingAt) VALUES(@id,@actor,@reference,@notes,SYSUTCDATETIME()); UPDATE dbo.Requests SET Status=\'HO processing\',UpdatedAt=SYSUTCDATETIME() WHERE Id=@id',{actor:p.id(req.user.Id),reference:p.text(body.reference,250),notes:p.text(body.notes,2000),id:p.id(requestId)});
   await audit(query,req,'fulfilment.processing_recorded',requestId,{reference:body.reference});await notify(query,ticket.RequesterId,requestId,`${ticket.TicketNumber}: processing started.`);
  });res.status(204).end();
 });
 router.post('/requests/:id/complete',roles('IT'),recentAuth,async(req,res)=>{
  const requestId=uuidParam(req),body=parse(z.object({version,notes:text(2000),confirmedProvisioned:z.literal(true),credentials:z.array(z.object({employeeId:text(40),systemId:id,username:text(150),password:z.string().min(1).max(256)}).strict()).max(300).default([])}).strict(),req.body);
  await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});assertVersion(ticket,body.version);requireCondition(processingStates.includes(ticket.Status),409,'NOT_READY_FOR_COMPLETION');requireCondition(ticket.RequesterId!==req.user.Id&&ticket.SubjectUserId!==req.user.Id,403,'SEPARATION_OF_DUTIES');
   await requireEmailDraftsSent(query,requestId);
   const items=(await query('SELECT i.*,rp.UserId,rp.EmployeeId,rp.Name,rp.BranchId,rp.DepartmentId FROM dbo.RequestItems i JOIN dbo.RequestPeople rp ON rp.Id=i.PersonId WHERE i.RequestId=@id',{id:p.id(requestId)})).recordset;
   const needsCredentials=!['employee-deactivate','system-deactivate','mailing-group','auto-forward'].includes(ticket.TypeCode);
   if(needsCredentials)requireCondition(items.every(item=>body.credentials.some(credential=>credential.employeeId===item.EmployeeId&&credential.systemId===item.SystemId)),400,'CREDENTIALS_INCOMPLETE');
   requireCondition(body.credentials.every(credential=>items.some(item=>item.EmployeeId===credential.employeeId&&item.SystemId===credential.systemId)),400,'UNREQUESTED_CREDENTIAL');
   for(const item of items){
    if(!item.UserId){
     const beneficiary=(await query('SELECT Id,Name,BranchId,DepartmentId FROM dbo.Users WHERE EmployeeId=@employee AND Active=1',{employee:p.text(item.EmployeeId,40)})).recordset[0];
     if(beneficiary&&beneficiary.Name===item.Name&&beneficiary.BranchId===item.BranchId&&beneficiary.DepartmentId===item.DepartmentId){
      item.UserId=beneficiary.Id;
      await query('UPDATE dbo.RequestPeople SET UserId=@user WHERE Id=@person',{user:p.id(beneficiary.Id),person:p.id(item.PersonId)});
     }
    }
    requireCondition(item.UserId,409,'BENEFICIARY_NOT_REGISTERED','Register each beneficiary in the directory before completing the request.');
   }
   const subjects=[...new Set(items.map(item=>item.UserId))];
   if(ticket.TypeCode==='employee-deactivate'){
    for(const userId of subjects){
     requireCondition(userId!==req.user.Id,403,'SELF_DEACTIVATION_FORBIDDEN');
     const user=(await query('SELECT Role FROM dbo.Users WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id',{id:p.id(userId)})).recordset[0];requireCondition(!['Platform Admin','Super Admin'].includes(user.Role),403,'ADMIN_DEACTIVATION_REQUIRES_ADMIN');
     await query('UPDATE dbo.AccessGrants SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@id AND RevokedAt IS NULL; UPDATE dbo.Users SET Active=0,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id; UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@id',{id:p.id(userId)});
    }
   }else{
    const updated=new Set();
    for(const item of items){
     if(item.Operation==='reset')continue;
     const group=`${item.UserId}:${item.SystemId}`;
     if(ticket.TypeCode==='movement'&&!updated.has(`movement:${item.UserId}`)){
      // Replace transferable systems while preserving email/AD and unrelated services.
      await query('UPDATE g SET RevokedAt=SYSUTCDATETIME() FROM dbo.AccessGrants g JOIN dbo.Systems s ON s.Id=g.SystemId WHERE g.UserId=@user AND s.TransferManaged=1 AND g.RevokedAt IS NULL',{user:p.id(item.UserId)});updated.add(`movement:${item.UserId}`);
     }
     if(item.Operation==='revoke'){
      await query('UPDATE dbo.AccessGrants SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@user AND SystemId=@system AND (@role IS NULL OR SystemRoleId=@role) AND RevokedAt IS NULL',{user:p.id(item.UserId),system:p.id(item.SystemId),role:p.id(item.SystemRoleId)});continue;
     }
     if(item.Operation==='update'&&!updated.has(group)){
      await query('UPDATE dbo.AccessGrants SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@user AND SystemId=@system AND RevokedAt IS NULL',{user:p.id(item.UserId),system:p.id(item.SystemId)});updated.add(group);
     }
     const credential=body.credentials.find(row=>row.employeeId===item.EmployeeId&&row.systemId===item.SystemId);
     await query('IF NOT EXISTS(SELECT 1 FROM dbo.AccessGrants WITH(UPDLOCK,HOLDLOCK) WHERE UserId=@user AND SystemId=@system AND (SystemRoleId=@role OR (SystemRoleId IS NULL AND @role IS NULL)) AND RevokedAt IS NULL) INSERT dbo.AccessGrants(UserId,SystemId,SystemRoleId,Username,SourceRequestId) VALUES(@user,@system,@role,@username,@request)',{user:p.id(item.UserId),system:p.id(item.SystemId),role:p.id(item.SystemRoleId),username:p.text(credential?.username,150),request:p.id(requestId)});
    }
   }
   if(ticket.TypeCode==='movement')await query('UPDATE dbo.Users SET BranchId=@branch,DepartmentId=@department,UpdatedAt=SYSUTCDATETIME() WHERE Id=@user; UPDATE dbo.Sessions SET RevokedAt=SYSUTCDATETIME() WHERE UserId=@user',{branch:p.id(ticket.DestinationBranchId),department:p.id(ticket.DestinationDepartmentId),user:p.id(ticket.SubjectUserId)});
   if(body.credentials.length){
    const custodian=ticket.TypeCode==='new-user'?(await query("SELECT TOP(1) ActorId FROM dbo.RequestSteps WHERE RequestId=@id AND Role IN ('Branch manager','Department head') AND Status='Approved' ORDER BY Position",{id:p.id(requestId)})).recordset[0]?.ActorId:null;
    const recipient=ticket.TypeCode==='new-user'?custodian:ticket.SubjectUserId||ticket.RequesterId;
    requireCondition(recipient,409,'CUSTODIAN_REQUIRED');
    await query('INSERT dbo.CredentialDeliveries(RequestId,RecipientId,Ciphertext,ExpiresAt) VALUES(@request,@recipient,@cipher,DATEADD(hour,24,SYSUTCDATETIME()))',{request:p.id(requestId),recipient:p.id(recipient),cipher:p.long(seal(JSON.stringify(body.credentials),config.DATA_ENCRYPTION_KEY,`delivery:${requestId}:${recipient}`))});
    await notify(query,recipient,requestId,`${ticket.TicketNumber}: secure credential delivery available for 24 hours, one read.`);
   }
   await query("UPDATE dbo.Fulfilments SET ActorId=@actor,Notes=@notes,CompletedAt=SYSUTCDATETIME() WHERE RequestId=@id; IF @@ROWCOUNT=0 INSERT dbo.Fulfilments(RequestId,ActorId,Notes,CompletedAt) VALUES(@id,@actor,@notes,SYSUTCDATETIME()); UPDATE dbo.Requests SET Status='Completed',CompletedAt=SYSUTCDATETIME(),UpdatedAt=SYSUTCDATETIME() WHERE Id=@id",{actor:p.id(req.user.Id),notes:p.text(body.notes,2000),id:p.id(requestId)});
   await audit(query,req,'fulfilment.completed',requestId,{credentialCount:body.credentials.length});await notify(query,ticket.RequesterId,requestId,`${ticket.TicketNumber}: completed.`);
  });res.status(204).end();
 });
 router.get('/deliveries',async(req,res)=>{
  const result=await db.query('SELECT Id,RequestId,ExpiresAt FROM dbo.CredentialDeliveries WHERE RecipientId=@user AND ReadAt IS NULL AND Ciphertext IS NOT NULL AND ExpiresAt>SYSUTCDATETIME() ORDER BY CreatedAt DESC',{user:p.id(req.user.Id)});res.json({items:result.recordset});
 });
 router.post('/deliveries/:id/consume',recentAuth,async(req,res)=>{
  const deliveryId=uuidParam(req);const result=await db.transaction(async query=>{
   const delivery=(await query('SELECT * FROM dbo.CredentialDeliveries WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND RecipientId=@user AND ReadAt IS NULL AND Ciphertext IS NOT NULL AND ExpiresAt>SYSUTCDATETIME()',{id:p.id(deliveryId),user:p.id(req.user.Id)})).recordset[0];requireCondition(delivery,404,'DELIVERY_NOT_AVAILABLE');
   const credentials=JSON.parse(unseal(delivery.Ciphertext,config.DATA_ENCRYPTION_KEY,`delivery:${delivery.RequestId}:${req.user.Id}`));
   await query('UPDATE dbo.CredentialDeliveries SET ReadAt=SYSUTCDATETIME(),Ciphertext=NULL WHERE Id=@id',{id:p.id(deliveryId)});await audit(query,req,'credentials.consumed',deliveryId,{requestId:delivery.RequestId});return credentials;
  });res.json({credentials:result});
 });
 return router;
}
