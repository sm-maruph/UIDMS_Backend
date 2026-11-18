import {Router} from 'express';
import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {id,parse,text,uuidParam,z} from '../../core/validation.js';
import {audit} from '../audit/service.js';
import {recentAuth,roles} from '../auth/service.js';
import {version} from '../requests/schemas.js';
import {mergeApprovalChains} from '../requests/system-workflows.js';
import {emailFields,templateVariables,validTemplate,variablesForService} from './system-email.js';
import {categoryForType,emailServices} from './email-services.js';
const template=emailFields.extend({name:text(160),systemIds:z.array(id).max(200),category:z.enum(['',...Object.keys(emailServices)]).default('')});
const approval=z.object({steps:z.array(z.enum(['Manager','HR','IT','CITO','COO'])).max(5)}).strict();

export function emailTemplateRoutes(db){
 const router=Router();
 router.use('/system-email-templates',roles('IT','Platform Admin','Super Admin'));
 router.get('/system-email-templates',async(req,res)=>{
  const {recordsets:[templates,systems,members,overrides]}=await db.query(`SELECT * FROM dbo.SystemEmailTemplates ORDER BY Name;
    SELECT Id AS id,Name AS name,Active AS active FROM dbo.Systems ORDER BY Name;
    SELECT SystemId,TemplateId FROM dbo.SystemEmailTemplateSystems;
    SELECT TemplateId,TypeCode,Steps FROM dbo.SystemApprovalOverrides;`);
  const services=Object.entries(emailServices).map(([category,service])=>({category,requestTypes:service.types,variables:variablesForService(category),systemIds:systems.filter(system=>system.active&&(!service.systems||service.systems.includes(system.name))).map(system=>system.id)}));
  res.json({systems,services,variables:templateVariables,items:templates.map(row=>({id:row.Id,name:row.Name,category:row.Category,version:row.Version.toString('hex'),
   ...JSON.parse(row.Recipients),subject:row.Subject,body:row.Body,systemIds:members.filter(member=>member.TemplateId===row.Id).map(member=>member.SystemId),
   workflows:Object.fromEntries(overrides.filter(rule=>rule.TemplateId===row.Id).map(rule=>[rule.TypeCode,JSON.parse(rule.Steps)]))}))});
 });

 async function loadTemplate(query,templateId){
  const row=(await query('SELECT Version,Category FROM dbo.SystemEmailTemplates WITH (UPDLOCK,HOLDLOCK) WHERE Id=@id',{id:p.id(templateId)})).recordset[0];
  requireCondition(row,404,'TEMPLATE_NOT_FOUND');
  return row;
 }

 async function saveTemplate(req,res){
  const editing=req.method==='PUT';
  const body=parse((editing?template.extend({version}):template).strict(),req.body);
  const systemIds=[...new Set(body.systemIds)];
  const templateId=await db.transaction(async query=>{
   let templateId=editing?uuidParam(req):null;
   const service=body.category?emailServices[body.category]:null;
   const variables=variablesForService(body.category);
   requireCondition(validTemplate(body.subject,variables)&&validTemplate(body.body,variables),400,'INVALID_TEMPLATE_VARIABLE','Use variables available for this service.');
   requireCondition(service||systemIds.length,400,'SYSTEM_REQUIRED');
   const category=p.str(body.category,32);
   const params={category,serviceDefault:p.bit(Boolean(service&&!systemIds.length)),name:p.text(body.name,160),subject:p.text(body.subject,300),body:p.long(body.body),recipients:p.json({to:body.to,cc:body.cc})};
   const selected=(await query(`SELECT s.Id,s.Name,s.Active,ts.TemplateId FROM dbo.Systems s
    JOIN OPENJSON(@systems) requested ON s.Id=CONVERT(uniqueidentifier,requested.value)
    LEFT JOIN dbo.SystemEmailTemplateSystems ts ON ts.SystemId=s.Id AND ts.Category=@category`,{systems:p.json(systemIds),category})).recordset;
   requireCondition(selected.length===systemIds.length&&selected.every(system=>system.Active||(templateId&&system.TemplateId===templateId)),400,'INVALID_SYSTEM');
   requireCondition(!service?.systems||selected.every(system=>service.systems.includes(system.Name)),400,'INVALID_SERVICE_SYSTEM');
   requireCondition(selected.every(system=>!system.TemplateId||system.TemplateId===templateId),409,'SYSTEM_ALREADY_ASSIGNED','A system can belong to one template per service.');
   let membershipChanged=true;
   if(editing){
    const previous=await loadTemplate(query,templateId);
    requireCondition(previous.Category===body.category,400,'TEMPLATE_CATEGORY_IMMUTABLE');
    requireCondition(previous.Version.toString('hex')===body.version,409,'STALE_VERSION','Reload the template before editing it.');
    const membership=(await query('SELECT SystemId FROM dbo.SystemEmailTemplateSystems WHERE TemplateId=@id',{id:p.id(templateId)})).recordset;
    membershipChanged=membership.length!==systemIds.length||membership.some(row=>!systemIds.includes(row.SystemId));
    if(membershipChanged){
     const overrides=(await query('SELECT TypeCode FROM dbo.SystemApprovalOverrides WHERE TemplateId=@id',{id:p.id(templateId)})).recordset;
     requireCondition(req.user.Role!=='IT'||!overrides.length,403,'ADMIN_REQUIRED','An administrator must change the systems on a group with approval overrides.');
     await query('DELETE dbo.SystemEmailTemplateSystems WHERE TemplateId=@id',{id:p.id(templateId)});
    }
    await query('UPDATE dbo.SystemEmailTemplates SET Name=@name,Subject=@subject,Body=@body,Recipients=@recipients,IsServiceDefault=@serviceDefault WHERE Id=@id',{...params,id:p.id(templateId)});
   }else{
    templateId=(await query('INSERT dbo.SystemEmailTemplates(Name,Recipients,Subject,Body,Category,IsServiceDefault) OUTPUT inserted.Id VALUES(@name,@recipients,@subject,@body,@category,@serviceDefault)',params)).recordset[0].Id;
   }
   if(membershipChanged)await query('INSERT dbo.SystemEmailTemplateSystems(SystemId,TemplateId,Category) SELECT CONVERT(uniqueidentifier,value),@id,@category FROM OPENJSON(@systems)',{id:p.id(templateId),systems:p.json(systemIds),category});
   await audit(query,req,editing?'system_email_template.updated':'system_email_template.created',templateId,{systemIds});
   return templateId;
  });
  res.status(editing?200:201).json({id:templateId});
 }
 router.post('/system-email-templates',recentAuth,saveTemplate);
 router.put('/system-email-templates/:id',recentAuth,saveTemplate);
 router.delete('/system-email-templates/:id',recentAuth,async(req,res)=>{
  const templateId=uuidParam(req),body=parse(z.object({version}).strict(),req.body),id=p.id(templateId);
  await db.transaction(async query=>{
   const previous=await loadTemplate(query,templateId);
   requireCondition(previous.Version.toString('hex')===body.version,409,'STALE_VERSION','Reload the template before deleting it.');
   const rules=(await query('SELECT TypeCode FROM dbo.SystemApprovalOverrides WHERE TemplateId=@id',{id})).recordset;
   requireCondition(!rules.length,409,'WORKFLOW_OVERRIDE_EXISTS','An administrator must remove this group’s approval overrides before deletion.');
   await query('DELETE dbo.SystemEmailTemplateSystems WHERE TemplateId=@id; DELETE dbo.SystemEmailTemplates WHERE Id=@id',{id});
   await audit(query,req,'system_email_template.deleted',templateId);
  });
  res.status(204).end();
 });
 router.put('/system-email-templates/:id/workflows/:code',roles('Platform Admin','Super Admin'),recentAuth,async(req,res)=>{
  const templateId=uuidParam(req),typeCode=parse(z.string().regex(/^[a-z-]{1,50}$/),req.params.code),{steps}=parse(approval,req.body);
  requireCondition(typeCode!=='reset',400,'FIXED_APPROVAL_CHAIN','Reset/unlock keeps its CITO-only approval.');
  await db.transaction(async query=>{
   const group=await loadTemplate(query,templateId);
   requireCondition(!group.Category||group.Category===categoryForType(typeCode),400,'WORKFLOW_SERVICE_MISMATCH');
   const params={id:p.id(templateId),type:p.str(typeCode,50)};
   const type=(await query('SELECT IncludesHr FROM dbo.RequestTypes WITH (UPDLOCK,HOLDLOCK) WHERE Code=@type AND Active=1',params)).recordset[0];
   requireCondition(type,404,'REQUEST_TYPE_NOT_FOUND');
   if(steps.length){
    const required=['IT','CITO','COO',...(type.IncludesHr?['Manager','HR']:[])];
    requireCondition(steps.length===new Set(steps).size&&required.every(role=>steps.includes(role)),400,'INVALID_APPROVAL_CHAIN',`Include each required stage once (${required.join(', ')}).`);
    const baseline=(await query('SELECT Role FROM dbo.WorkflowSteps WHERE TypeCode=@type ORDER BY Position',params)).recordset;
    const otherRules=(await query('SELECT Steps FROM dbo.SystemApprovalOverrides WHERE TypeCode=@type AND TemplateId<>@id',params)).recordset;
    mergeApprovalChains([baseline.map(row=>row.Role),...otherRules.map(row=>JSON.parse(row.Steps)),steps]);
   }
   await query('DELETE dbo.SystemApprovalOverrides WHERE TemplateId=@id AND TypeCode=@type',params);
   if(steps.length)await query('INSERT dbo.SystemApprovalOverrides(TemplateId,TypeCode,Steps) VALUES(@id,@type,@steps)',{...params,steps:p.json(steps)});
   await audit(query,req,'system_approval_override.updated',templateId,{typeCode,steps});
  });
  res.status(204).end();
 });
 return router;
}
