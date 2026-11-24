import {Router} from 'express';
import {p,sql} from '../../core/db.js';
import {z,text,parse,pageSchema,id} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {roles} from '../auth/service.js';
import {finalizeAuditSessions} from './sessions.js';
import {audit} from './service.js';
import {loadTicket} from '../requests/repository.js';

const eventId=z.string().regex(/^[1-9]\d{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n);
const big=value=>({type:sql.BigInt,value:value==null?null:String(value)});
const filters=pageSchema.extend({search:text(100,0).default(''),event:text(100,0).default(''),category:z.enum(['all','auth','requests','approvals','queries','configuration','navigation']).default('all'),from:z.iso.date().optional(),to:z.iso.date().optional()}).strict().refine(value=>!value.from||!value.to||value.from<=value.to,'End date must be on or after start date.');
const categories={all:'1=1',auth:"a.Event LIKE 'auth.%'",requests:"(a.Event LIKE 'request.%' OR a.Event LIKE 'fulfilment.%' OR a.Event LIKE 'movement.%' OR a.Event LIKE 'hr.%')",approvals:"a.Event IN ('request.approve','request.reject')",queries:"a.Event LIKE 'query.%'",configuration:"(a.Event LIKE 'workflow.%' OR a.Event LIKE 'organization.%' OR a.Event LIKE 'role.%' OR a.Event LIKE 'user.%' OR a.Event LIKE 'system[_]%' OR a.Event LIKE 'system.%' OR a.Event LIKE 'lookup.%' OR a.Event LIKE 'mailing_group.%')",navigation:"a.Event='page.viewed'"};
const columns=`CONVERT(varchar(20),a.Id) AS Id,a.ActorId,a.Event,a.EntityId,a.Ip,a.CorrelationId,a.CreatedAt,a.Metadata,a.AuditSessionId,a.ActorRole,COALESCE(s.EmployeeId,u.EmployeeId) AS EmployeeId,COALESCE(s.Name,u.Name) AS Name,COALESCE(r.TicketNumber,rt.Name,l.Name,a.EntityId) AS RecordName`;
const joins=`FROM dbo.AuditEvents a LEFT JOIN dbo.Users u ON u.Id=a.ActorId LEFT JOIN dbo.AuditSessions s ON s.Id=a.AuditSessionId
 LEFT JOIN dbo.Requests r ON r.Id=TRY_CONVERT(uniqueidentifier,a.EntityId) LEFT JOIN dbo.RequestTypes rt ON rt.Code=a.EntityId LEFT JOIN dbo.Lookups l ON l.Id=TRY_CONVERT(uniqueidentifier,a.EntityId)`;
export function redactAudit(value,depth=0){
 if(depth>12)return '[Details omitted]';
 if(Array.isArray(value))return value.map(item=>redactAudit(item,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/password|secret|token|hash|csrf|ciphertext|signature|cookie|authorization/i.test(key)?'[Redacted]':redactAudit(item,depth+1)]));
 return value;
}
const eventRow=row=>{let metadata={};try{metadata=JSON.parse(row.Metadata||'{}');}catch{}return {...row,Id:String(row.Id),Metadata:redactAudit(metadata)};};
const dateStart=value=>value?new Date(value+'T00:00:00+06:00'):null;
async function sessionEvents(query,condition,params,page){
 const result=await query(`SELECT COUNT(*) AS Total ${joins} WHERE ${condition}; SELECT ${columns} ${joins} WHERE ${condition} ORDER BY a.CreatedAt,a.Id OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`,{...params,offset:p.int((page.page-1)*page.pageSize),size:p.int(page.pageSize)});
 return {items:result.recordsets[1].map(eventRow),total:result.recordsets[0][0].Total,...page};
}
export async function readAuditSession(db,config,event,page){
 const row=(await db.query(`SELECT ${columns},CAST(CASE WHEN a.CreatedAt<(SELECT AppliedAt FROM dbo.SchemaVersions WHERE Version=13) THEN 1 ELSE 0 END AS bit) AS Historical ${joins} WHERE a.Id=@id`,{id:big(event)})).recordset[0];
 requireCondition(row,404,'AUDIT_EVENT_NOT_FOUND');
 let sessionId=row.AuditSessionId;
 if(!sessionId&&row.CorrelationId&&row.ActorId)sessionId=(await db.query("SELECT TOP(1) AuditSessionId FROM dbo.AuditEvents WHERE ActorId=@actor AND CorrelationId=@correlation AND Event='auth.login' AND AuditSessionId IS NOT NULL ORDER BY Id",{actor:p.id(row.ActorId),correlation:p.id(row.CorrelationId)})).recordset[0]?.AuditSessionId;
 if(sessionId){
  const header=(await db.query('SELECT Id,UserId,EmployeeId,Name,Role,AuthProvider,StartedAt,LastSeenAt,ExpiresAt,Ip,LastIp,UserAgent,EndedAt,EndReason,Source FROM dbo.AuditSessions WHERE Id=@session',{session:p.id(sessionId)})).recordset[0];requireCondition(header,404,'AUDIT_SESSION_NOT_FOUND');
  const condition=`(a.AuditSessionId=@session OR a.Id=@anchor OR (@migrated=1 AND a.AuditSessionId IS NULL AND a.ActorId=@actor AND a.CreatedAt>=@start AND a.CreatedAt<=@end))`;
  const result=await sessionEvents(db.query,condition,{session:p.id(sessionId),anchor:big(row.Id),migrated:p.bit(header.Source==='migrated'),actor:p.id(header.UserId),start:p.date(header.StartedAt),end:p.date(header.EndedAt||header.ExpiresAt)},page);
  return {...result,session:{...header,status:header.EndedAt?'Ended':'Active'},anchor:eventRow(row),...(header.Source==='migrated'?{notice:'This session predates session tracking. Older unlinked activity is grouped by the available account and time boundaries.'}:{})};
 }
 if(row.Historical&&row.ActorId){
  const start=(await db.query(`SELECT TOP(1) CONVERT(varchar(20),Id) AS Id,CreatedAt,Ip,Metadata,CorrelationId FROM dbo.AuditEvents
   WHERE ActorId=@actor AND Event='auth.login' AND (Id<=@anchor OR CorrelationId=@correlation) ORDER BY CASE WHEN CorrelationId=@correlation THEN 0 ELSE 1 END,Id DESC`,{actor:p.id(row.ActorId),anchor:big(row.Id),correlation:p.id(row.CorrelationId)})).recordset[0];
  if(start){
   const boundary=(await db.query(`SELECT TOP(1) CONVERT(varchar(20),Id) AS Id,Event,CreatedAt,CorrelationId FROM dbo.AuditEvents WHERE ActorId=@actor AND Id>@start AND Event IN ('auth.login','auth.logout') ORDER BY Id`,{actor:p.id(row.ActorId),start:big(start.Id)})).recordset[0];
   if(boundary&&BigInt(boundary.Id)<BigInt(row.Id)&&row.CorrelationId!==start.CorrelationId)return {session:null,anchor:eventRow(row),items:[eventRow(row)],total:1,...page,notice:'This older event was recorded after sign-out, outside the preceding session.'};
   const condition=`a.ActorId=@actor AND a.AuditSessionId IS NULL AND ((a.Id>=@start AND (@end IS NULL OR a.Id<@end OR (@logout=1 AND a.Id=@end)) AND (@nextCorrelation IS NULL OR a.CorrelationId<>@nextCorrelation)) OR a.CorrelationId=@loginCorrelation)`;
   const result=await sessionEvents(db.query,condition,{actor:p.id(row.ActorId),start:big(start.Id),end:big(boundary?.Id),logout:p.bit(boundary?.Event==='auth.logout'),nextCorrelation:p.id(boundary?.Event==='auth.login'?boundary.CorrelationId:null),loginCorrelation:p.id(start.CorrelationId)},page);
   return {...result,session:{Id:null,UserId:row.ActorId,EmployeeId:row.EmployeeId,Name:row.Name,Role:null,StartedAt:start.CreatedAt,EndedAt:boundary?.CreatedAt||null,EndReason:boundary?.Event==='auth.logout'?'logout':boundary?'next_login':'not_recorded',Ip:start.Ip,Source:'inferred',status:'Historical'},anchor:eventRow(row),notice:'Older events were grouped using recorded sign-in and sign-out boundaries. Exact session identifiers were not recorded then.'};
  }
 }
 return {session:null,anchor:eventRow(row),items:[eventRow(row)],total:1,...page,notice:row.Historical?'No sign-in boundary was recorded for this older activity.':'This event was recorded outside an authenticated session.'};
}
export function auditRoutes(db,config){
 const router=Router();
 router.get('/audit',roles('Admin','Super Admin'),async(req,res)=>{
  const filter=parse(filters,req.query);await db.transaction(query=>finalizeAuditSessions(query,config));
  const from=dateStart(filter.from),to=dateStart(filter.to);if(to)to.setTime(to.getTime()+86400000);
  const where=`${categories[filter.category]} AND (@event='' OR a.Event=@event) AND (@from IS NULL OR a.CreatedAt>=@from) AND (@to IS NULL OR a.CreatedAt<@to)
   AND (@search=N'' OR CHARINDEX(@search,a.Event)>0 OR CHARINDEX(@search,a.Ip)>0 OR CHARINDEX(@search,u.EmployeeId)>0 OR CHARINDEX(@search,u.Name)>0 OR CHARINDEX(@search,a.EntityId)>0 OR CHARINDEX(@search,r.TicketNumber)>0)`;
  const result=await db.query(`SELECT COUNT(*) AS Total,COUNT(DISTINCT a.ActorId) AS People,COALESCE(SUM(CASE WHEN a.Event='auth.login' THEN 1 ELSE 0 END),0) AS SignIns ${joins} WHERE ${where}; SELECT ${columns} ${joins} WHERE ${where} ORDER BY a.CreatedAt DESC,a.Id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`,{event:p.str(filter.event),search:p.text(filter.search,100),from:p.date(from),to:p.date(to),offset:p.int((filter.page-1)*filter.pageSize),size:p.int(filter.pageSize)});
  const stats=result.recordsets[0][0];res.json({items:result.recordsets[1].map(eventRow),total:stats.Total,stats:{people:stats.People,signIns:stats.SignIns},page:filter.page,pageSize:filter.pageSize});
 });
 router.get('/audit/:id/session',roles('Admin','Super Admin'),async(req,res)=>{const event=parse(eventId,req.params.id),page=parse(pageSchema.strict(),req.query);await db.transaction(query=>finalizeAuditSessions(query,config));const result=await readAuditSession(db,config,event,page);await audit(db.query,req,'audit.session_viewed',result.session?.Id||event,{eventId:event});res.json(result);});
 const pages=['Overview','My requests','My access','Create a request','Approvals','Reports','User directory','Audit trail','Acting appointments','Approver assignments','Workflow studio','Admin settings','System Email Templates','Joiners & transfers','Branch / Department change','Ticket details','Profile editor'];
 router.post('/activity',async(req,res)=>{
  const body=parse(z.object({page:z.enum(pages),ticketId:id.optional()}).strict(),req.body);
  requireCondition(req.auditSessionId,409,'SESSION_TRACKING_UNAVAILABLE','Sign out and sign in again to start activity tracking.');
  await db.transaction(async query=>{if(body.ticketId)await loadTicket(query,body.ticketId,req.user);await audit(query,req,'page.viewed',body.ticketId||body.page,{page:body.page,source:'client-navigation'});});res.status(204).end();
 });
 return router;
}
