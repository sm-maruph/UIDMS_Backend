import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,id,text,parse,uuidParam} from '../../core/validation.js';
import {roles,recentAuth} from '../auth/service.js';
import {requireCondition} from '../../core/errors.js';
import {audit} from '../audit/service.js';
import {workflowRoles} from '../requests/policy.js';
export function adminRoutes(db,config){
 const router=Router();router.use(roles('Super Admin'),recentAuth);
 router.put('/workflows/:code',async(req,res)=>{
  const code=parse(z.string().regex(/^[a-z-]{1,50}$/),req.params.code);
  const body=parse(z.object({roles:z.array(z.enum(['Manager','HR','IT','CITO','COO'])).min(1).max(5)}).strict(),req.body);
  requireCondition(code==='reset'?JSON.stringify(body.roles)===JSON.stringify(workflowRoles('reset')):body.roles[0]==='Manager'&&body.roles.slice(-3).join(',')==='IT,CITO,COO'&&new Set(body.roles).size===body.roles.length,400,'INVALID_WORKFLOW','Reset/unlock requires CITO only. Other workflows require Manager, optional HR, IT, CITO, COO.');
  await db.transaction(async query=>{
   const row=(await query('SELECT * FROM dbo.RequestTypes WITH(UPDLOCK,HOLDLOCK) WHERE Code=@code',{code:p.str(code,50)})).recordset[0];requireCondition(row,404,'TYPE_NOT_FOUND');
   requireCondition(!['new-user','movement','branch-transfer','employee-deactivate'].includes(code)||body.roles.includes('HR'),400,'HR_STAGE_REQUIRED');
   const previous=(await query('SELECT Role FROM dbo.WorkflowSteps WHERE TypeCode=@code ORDER BY Position',{code:p.str(code,50)})).recordset;
   await query('DELETE dbo.WorkflowSteps WHERE TypeCode=@code',{code:p.str(code,50)});
   for(const [index,role] of body.roles.entries())await query('INSERT dbo.WorkflowSteps(TypeCode,Position,Role) VALUES(@code,@position,@role)',{code:p.str(code,50),position:p.int(index+1),role:p.text(role,40)});
   await query('UPDATE dbo.RequestTypes SET IncludesHr=@hr WHERE Code=@code',{hr:p.bit(body.roles.includes('HR')),code:p.str(code,50)});await audit(query,req,'workflow.updated',code,{previous:previous.map(row=>row.Role),roles:body.roles});
  });res.status(204).end();
 });
 router.post('/mailing-groups',async(req,res)=>{
  const body=parse(z.object({name:text(160),email:z.email().max(254)}).strict(),req.body);
  requireCondition(config.MAIL_ALLOWED_DOMAINS.split(',').includes(body.email.split('@')[1].toLowerCase()),400,'EMAIL_DOMAIN_NOT_ALLOWED');
  const result=await db.transaction(async query=>{const row=(await query('INSERT dbo.MailingGroups(Name,Email) OUTPUT inserted.Id VALUES(@name,@email)',{name:p.text(body.name,160),email:p.text(body.email,254)})).recordset[0];await audit(query,req,'mailing_group.created',row.Id);return row;});res.status(201).json({id:result.Id});
 });
 router.get('/mailing-groups/:id/members',async(req,res)=>{
  const group=uuidParam(req);
  const {recordset}=await db.query('SELECT UserId FROM dbo.MailingGroupMembers WHERE GroupId=@group',{group:p.id(group)});
  res.json({userIds:recordset.map(row=>row.UserId)});
 });
 router.put('/mailing-groups/:id/members',async(req,res)=>{
  const group=uuidParam(req),body=parse(z.object({userIds:z.array(id).max(500)}).strict(),req.body);
  await db.transaction(async query=>{
   requireCondition((await query('SELECT Id FROM dbo.MailingGroups WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Active=1',{id:p.id(group)})).recordset.length,404,'GROUP_NOT_FOUND');
   await query('DELETE dbo.MailingGroupMembers WHERE GroupId=@id',{id:p.id(group)});
   for(const userId of new Set(body.userIds)){requireCondition((await query('SELECT Id FROM dbo.Users WHERE Id=@id AND Active=1',{id:p.id(userId)})).recordset.length,400,'INVALID_MEMBER');await query('INSERT dbo.MailingGroupMembers(GroupId,UserId) VALUES(@group,@user)',{group:p.id(group),user:p.id(userId)});}
   await audit(query,req,'mailing_group.members_updated',group,{memberCount:body.userIds.length});
  });res.status(204).end();
 });
 return router;
}
