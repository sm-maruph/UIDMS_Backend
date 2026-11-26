import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes} from 'node:crypto';import express from 'express';import request from 'supertest';
import {readConfig} from '../src/config.js';import {createDatabase,p} from '../src/core/db.js';import {requestRoutes} from '../src/modules/requests/routes.js';import {errorHandler} from '../src/core/errors.js';

test('SQL request PDF/print uses saved requester and approver names/times and audits document generation',{skip:process.env.UIDMS_SQL_DOCUMENT_SMOKE!=='true',timeout:45000},async()=>{
 const config=readConfig();assert.equal(config.NODE_ENV,'development');assert.ok(['localhost','127.0.0.1','::1'].includes(config.DB_SERVER));
 const db=createDatabase(config),rollback=new Error('Request document fixture rollback'),suffix=randomBytes(5).toString('hex');
 try{await db.connect();await assert.rejects(db.transaction(async query=>{
  const lookup={};for(const kind of ['branch','department'])lookup[kind]=(await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(kind,20),name:p.text('Document '+kind+' '+suffix,150)})).recordset[0].Id;
  const actors={};for(const [key,role] of [['requester','User'],['head','Department head'],['it','IT'],['cito','CITO'],['coo','COO']])actors[key]=(await query('INSERT dbo.Users(EmployeeId,Name,Role,BranchId,DepartmentId) OUTPUT inserted.* VALUES(@employee,@name,@role,@branch,@department)',{employee:p.text('DOC_'+suffix+'_'+key,40),name:p.text('Document '+key,160),role:p.text(role,40),branch:p.id(lookup.branch),department:p.id(lookup.department)})).recordset[0];
  const ticket=(await query("INSERT dbo.Requests(TicketNumber,TypeCode,RequesterId,BranchId,DepartmentId,Status,CurrentPosition,Justification,Details,RequesterSnapshot,SubmittedIp) OUTPUT inserted.Id VALUES(@ticket,'reset',@user,@branch,@department,'Completed',5,N'Test reset request',N'{}',N'{}','127.0.0.1')",{ticket:p.text('DOC-'+suffix,40),user:p.id(actors.requester.Id),branch:p.id(lookup.branch),department:p.id(lookup.department)})).recordset[0].Id;
  for(const [index,key] of ['head','it','cito','coo'].entries())await query("INSERT dbo.RequestSteps(RequestId,Position,Role,DepartmentId,Status,ActorId,Remark,DecidedAt) VALUES(@request,@position,@role,@department,'Approved',@actor,N'Recorded remark',SYSUTCDATETIME())",{request:p.id(ticket),position:p.int(index+1),role:p.text(actors[key].Role,40),department:p.id(key==='head'?lookup.department:null),actor:p.id(actors[key].Id)});
  const app=express();app.use((req,res,next)=>{req.user=actors.cito;req.id=randomUUID();next();});app.use('/api/requests',requestRoutes({query,transaction:work=>work(query)}));app.use(errorHandler);
  const printed=await request(app).get(`/api/requests/${ticket}/document?format=html`);assert.equal(printed.status,200,printed.text);for(const key of ['requester','head','it','cito','coo'])assert.ok(printed.text.includes(actors[key].Name));assert.match(printed.text,/grid-template-columns:repeat\(5/);
  const downloaded=await request(app).get(`/api/requests/${ticket}/document?format=pdf`);assert.equal(downloaded.status,200);assert.equal(downloaded.body.subarray(0,5).toString(),'%PDF-');assert.match(downloaded.headers['content-disposition'],/request.pdf/);
  assert.equal((await query("SELECT COUNT(*) AS Total FROM dbo.AuditEvents WHERE ActorId=@actor AND EntityId=@ticket AND Event='request.document_generated'",{actor:p.id(actors.cito.Id),ticket:p.text(ticket,80)})).recordset[0].Total,2);
  await query('UPDATE dbo.Requests SET DeletedAt=SYSUTCDATETIME() WHERE Id=@id',{id:p.id(ticket)});assert.equal((await request(app).get(`/api/requests/${ticket}/document`)).status,404);
  throw rollback;
 }),error=>error===rollback);}finally{await db.close();}
});
