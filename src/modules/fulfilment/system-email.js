import {p} from '../../core/db.js';
import {text,z} from '../../core/validation.js';
import {categoryForType,emailServices} from './email-services.js';
import {applyProcessingCc} from './email-recipients.js';

export const itemVariables=['name','employeeId','system','systemId','role','operation','department','branch','reason'];
export const templateVariables=['ticketNumber','requestType','justification','items',...itemVariables];
const tokenPattern=/\{\{\s*([\w]+)\s*\}\}/g;

export const emailFields=z.object({
 to:z.array(z.email().max(254)).min(1).max(20),
 cc:z.array(z.email().max(254)).max(20).default([]),
 subject:text(300).refine(value=>!/[\r\n\t]/.test(value),'Use a single line for the subject'),
 body:text(4000),
});
// A template allows 20 optional CCs, plus the two fixed mailboxes and requester.
export const processingEmailFields=emailFields.extend({cc:z.array(z.email().max(254)).max(23).default([]),body:text(200000)});

export function variablesForService(category){
 const service=emailServices[category];
 return service?[...templateVariables.filter(key=>!['role','reason'].includes(key)||['new-id','upgrade'].includes(category)),...service.variables]:templateVariables;
}

export function validTemplate(value,variables=templateVariables){
 return !/\{\{|\}\}/.test(value.replace(tokenPattern,(match,key)=>variables.includes(key)?'':match));
}

function serviceValues(ticket,items){
 const saved=JSON.parse(ticket.Details||'{}');
 const data=saved.submittedForm?.data||saved;
 const requester=JSON.parse(ticket.RequesterSnapshot||'{}');
 const array=value=>Array.isArray(value)?value:[];
 const person=item=>array(data.newUserDetails?.people).find(row=>row?.employeeId===item.EmployeeId)||JSON.parse(item.PersonDetails||'{}');
 const join=values=>[...new Set([values].flat(2).filter(value=>typeof value==='string'&&value.trim()))].join(', ');
 const perPerson=key=>join(items.map(item=>person(item)[key]));
 const perSystem=map=>join(items.map(item=>map?.[item.SystemId]??map?.[item.SystemName]));
 const {mailingGroupDetails:group,autoForwardDetails:forward,externalDeviceDetails:device,emailCreationDetails:mail,deactivationDetails:deactivation,upgradeDetails:upgrade,transferDetails:transfer}=data;
 return {
  designation:deactivation?.designation||mail?.designation||perPerson('designation')||data.designation,
  email:group?.profileEmail||forward?.profileEmail||device?.email||deactivation?.email||perPerson('email')||data.email||requester.email,
  requestedEmail:mail?.email||data.requestedEmail||join(items.filter(item=>item.SystemName==='Email').map(item=>person(item).preferredEmail)).split(', ').filter(Boolean).map(name=>`${name}@combankbd.com`).join(', '),
  adRole:join(items.filter(item=>item.SystemName==='AD ID').map(item=>person(item).adRole)),
  otherSoftware:join(items.filter(item=>item.SystemName==='Other software').map(item=>person(item).otherSoftware)),
  scope:deactivation?.scope||data.scope||(ticket.TypeCode==='employee-deactivate'?'all systems':'selected systems'),
  groupAction:group?.action||data.groupAction,mailingGroups:join(group?.groupAddresses||[data.mailingGroups]),forwardTo:forward?.forwardTo||data.forwardTo,
  driveName:data.driveName||join(items.map(item=>array(array(data.batchDetails?.people).find(row=>row?.employeeId===item.EmployeeId)?.systems).find(row=>row?.system===item.SystemName)?.driveName||person(item).driveName)),
  deviceModel:device?.deviceModel||data.deviceModel,deviceNumber:device?.deviceNumber||data.deviceNumber,serialNumber:device?.serialNumber||data.serialNumber,
  currentRole:perSystem(upgrade?.currentAccess||data.currentAccess),similarId:perSystem(upgrade?.similarIds||transfer?.similarIds||data.similarIds),
  additionalFunction:perSystem(upgrade?.additionalFunctions||data.additionalFunctions)||join(items.flatMap(item=>['newAccess','newOtherAccess','newTestSystems','additionalTestSystems'].map(key=>transfer?.[`${key}Extra`]?.[item.SystemName]?.additionalFunction))),
 };
}

export function groupEmailDrafts(ticket,items){
 const groups=new Map();
 for(const item of items){
  const group=groups.get(item.TemplateId)||{items:[],template:item};
  group.items.push(item);
  groups.set(item.TemplateId,group);
 }
 return [...groups.values()].map(({items,template})=>{
  const rows=items.map(item=>({name:item.Name,employeeId:item.EmployeeId,system:item.SystemName,systemId:item.SystemId,role:item.RoleName,operation:item.Operation,department:item.Department,branch:item.Branch,reason:item.Reason}));
  const values={...serviceValues(ticket,items),ticketNumber:ticket.TicketNumber,requestType:ticket.Action,justification:ticket.Justification||'',
   items:rows.map(row=>`- ${row.system}: ${row.name} (${row.employeeId})${row.role?` / Role: ${row.role}`:''} / ${row.operation} / ${row.branch} / ${row.department}${row.reason?` / ${row.reason}`:''}`).join('\n')};
  for(const key of itemVariables)values[key]=[...new Set(rows.map(row=>row[key]).filter(Boolean))].join(', ');
  const render=value=>value.replace(tokenPattern,(_,key)=>Object.hasOwn(values,key)&&typeof values[key]==='string'?values[key]:'');
  const recipients=template.TemplateId?JSON.parse(template.Recipients):{to:[],cc:[]};
  const subject=render(template.Subject||'[{{ticketNumber}}] {{requestType}} - IT processing').replace(/[\r\n\t]+/g,' ').trim();
  const body=render(template.Body||'Dear Team,\n\nPlease process the following approved identity service request.\n\nTicket: {{ticketNumber}}\n{{items}}\n\nBusiness justification: {{justification}}\n\nPlease confirm completion to IT. Use the approved secure channel for credentials.\n\nRegards,\nInformation Technology Department');
  return {templateId:template.TemplateId,content:applyProcessingCc({...recipients,subject,body,name:template.TemplateName||'General processing',systems:[...new Set(rows.map(row=>row.system))]},ticket)};
 });
}

export async function readEmailDrafts(query,requestId,ticket){
 const result=await query(`SELECT d.Id,d.Content,d.SentAt,u.Name AS SentBy FROM dbo.RequestEmailDrafts d
 LEFT JOIN dbo.Users u ON u.Id=d.SentBy WHERE d.RequestId=@request ORDER BY d.Position`,{request:p.id(requestId)});
 return result.recordset.map(row=>{
  const content=JSON.parse(row.Content);
  return {id:row.Id,...(row.SentAt?content:applyProcessingCc(content,ticket)),sentAt:row.SentAt,sentBy:row.SentBy};
 });
}

// The caller holds the request lock so approval and legacy draft initialization serialize.
export async function createEmailDrafts(query,ticket){
 const items=(await query(`SELECT rp.Name,rp.EmployeeId,rp.Details AS PersonDetails,b.Name AS Branch,d.Name AS Department,
  i.SystemId,s.Name AS SystemName,sr.Name AS RoleName,i.Operation,i.Reason,
  t.Id AS TemplateId,t.Name AS TemplateName,t.Recipients,t.Subject,t.Body
  FROM dbo.RequestItems i JOIN dbo.RequestPeople rp ON rp.Id=i.PersonId
  JOIN dbo.Lookups b ON b.Id=rp.BranchId JOIN dbo.Lookups d ON d.Id=rp.DepartmentId
  JOIN dbo.Systems s ON s.Id=i.SystemId LEFT JOIN dbo.SystemRoles sr ON sr.Id=i.SystemRoleId
  OUTER APPLY (
   SELECT TOP (1) candidate.Id,candidate.Name,candidate.Recipients,candidate.Subject,candidate.Body
   FROM dbo.SystemEmailTemplates candidate
   LEFT JOIN dbo.SystemEmailTemplateSystems member ON member.Category=candidate.Category AND member.TemplateId=candidate.Id AND member.SystemId=i.SystemId
   WHERE candidate.Category=@category AND (member.SystemId IS NOT NULL OR candidate.IsServiceDefault=1)
   ORDER BY candidate.IsServiceDefault,candidate.Id
  ) t
  WHERE i.RequestId=@request ORDER BY t.Name,rp.EmployeeId,s.Name,sr.Name,i.Id`,{request:p.id(ticket.Id),category:p.str(categoryForType(ticket.TypeCode),32)})).recordset;
 for(const [index,draft] of groupEmailDrafts(ticket,items).entries()){
  await query('INSERT dbo.RequestEmailDrafts(RequestId,TemplateId,Position,Content) VALUES(@request,@template,@position,@content)',{request:p.id(ticket.Id),template:p.id(draft.templateId),position:p.int(index+1),content:p.json(draft.content)});
 }
}
