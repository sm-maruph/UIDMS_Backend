import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import request from 'supertest';
import {requestDocument,documentHtml} from '../src/modules/requests/document.js';import {documentPdf} from '../src/modules/requests/document-pdf.js';import {requestRoutes} from '../src/modules/requests/routes.js';import {errorHandler} from '../src/core/errors.js';import {user,requestId,actorId,otherId,branchId,departmentId} from './helpers.js';
const stamp='2026-11-25T05:00:00.000Z';
const detail={id:requestId,ticketNumber:'UID-2026-1001',typeCode:'reset',action:'Unlock / Reset',name:'Requester One',requesterId:'BD001',createdAt:stamp,branch:'Head Office BD',department:'IT',state:'In review',people:[{name:'Requester One',employeeId:'BD001'}],items:[{system:'ICBS',role:'Inquiry',operation:'reset'}],details:{reason:'<img src=x onerror=alert(1)>',password:'do-not-export',nested:{secret:'do-not-export',signature:'data:image/png;base64,x'}},workflowSteps:[{position:1,role:'Department head',status:'Approved',by:'Actual manager',assignedName:'Someone else',at:stamp,remark:'Recommended'},{position:2,role:'IT',status:'Approved',by:'Actual IT',at:stamp},{position:3,role:'CITO',status:'Waiting',assignedName:'Assigned CITO'}]};

test('document sign-off uses actual decision actors/times and labels waiting entries honestly',()=>{
 const report=requestDocument(detail,user,new Date(stamp));assert.deepEqual(report.approvals.map(row=>row.role),['Requester','Branch manager / Department head','IT','CITO']);assert.equal(report.approvals[1].entries[0].name,'Actual manager');assert.equal(report.approvals[3].entries[0].status,'Pending');assert.equal(report.approvals[3].entries[0].at,null);assert.equal(JSON.stringify(report).includes('do-not-export'),false);assert.equal(report.approvals.some(row=>row.role==='COO'),false);
 const html=documentHtml(report);assert.match(html,/&lt;img/);assert.equal(html.includes('<img src=x'),false);assert.match(html,/grid-template-columns:repeat\(4/);
 const processing=requestDocument({...detail,workflowSteps:[],fulfilment:{ActorName:'Actual processor',CompletedAt:stamp}},user);assert.equal(processing.approvals[1].role,'IT / Processing');assert.equal(processing.approvals[1].entries[0].name,'Actual processor');
});

test('printed form header embeds both logos in the requested order and uses the service title',()=>{
 const report=requestDocument({...detail,typeCode:'external-device'},user),html=documentHtml(report);
 assert.ok(html.indexOf('class="uidms-logo"')<html.indexOf('class="bank-heading"'));assert.ok(html.indexOf('class="bank-heading"')<html.indexOf('class="bank-logo"'));
 assert.match(html,/Commercial Bank of Ceylon PLC/);assert.match(html,/Bangladesh Operations/);assert.match(html,/User ID Request Form - External Device Email Access/);
 assert.match(html,/Business justification is mandatory/);assert.equal((html.match(/src="data:image\/png;base64,/g)||[]).length,2);
 const reset=documentHtml(requestDocument(detail,user));assert.equal(reset.includes('Business justification is mandatory'),false);
});

test('PDF produces a real paginated document with long fields and side-by-side review records',async()=>{
 const report=requestDocument(detail,user);report.fields=Array.from({length:90},(_,i)=>({label:'Field '+i,value:('Detailed requested access\n').repeat(15)}));const pdf=await documentPdf(report);assert.match(pdf.subarray(0,8).toString(),/^%PDF-/);assert.ok(pdf.length>5000);assert.match(pdf.toString('latin1'),/\/Type \/Pages/);assert.match(pdf.toString('latin1'),/\/Count [2-9]\d*/);assert.ok((pdf.toString('latin1').match(/\/Subtype \/Image/g)||[]).length>=2);
});

function fixture(Role='IT',found=true,eligible=undefined){const calls=[];const ticket={Id:requestId,TicketNumber:detail.ticketNumber,TypeCode:'reset',RequesterId:otherId,RequesterName:detail.name,EmployeeId:'BD001',Branch:detail.branch,Department:'IT',BranchId:branchId,DepartmentId:departmentId,Status:'Completed',CurrentPosition:4,CreatedAt:stamp,Version:Buffer.alloc(8),Details:'{}',RequesterSnapshot:'{}'};const query=async(sql,params)=>{calls.push({sql,params});if(sql.startsWith('SELECT r.*'))return{recordset:found?[ticket]:[]};if(sql.startsWith('SELECT rp.*'))return{recordsets:[[],[],[{Position:1,Role:'CITO',Status:'Approved',ActorId:actorId,ActorName:'CITO actor',DecidedAt:stamp,EligibleReviewers:eligible}],[],[],[],[]]};return{recordset:[]};};const app=express();app.use((req,res,next)=>{req.user={...user,Role};req.id=requestId;next();});app.use('/api/requests',requestRoutes({query,transaction:work=>work(query)}));app.use(errorHandler);return{app,calls};}

test('only IT, CITO, Admin and Super Admin can generate request files; generation is audited',async()=>{
 for(const Role of ['User','HR','COO','Department head','Branch manager']){const f=fixture(Role);assert.equal((await request(f.app).get(`/api/requests/${requestId}/document`)).status,403);assert.equal(f.calls.length,0);}
 for(const Role of ['IT','CITO','Admin','Super Admin']){const f=fixture(Role),response=await request(f.app).get(`/api/requests/${requestId}/document?format=pdf`);assert.equal(response.status,200);assert.match(response.headers['content-type'],/application\/pdf/);assert.match(response.headers['content-disposition'],/UID-2026-1001-request.pdf/);assert.equal(response.body.subarray(0,5).toString(),'%PDF-');assert.ok(f.calls.some(call=>call.params?.event?.value==='request.document_generated'));}
 const html=await request(fixture().app).get(`/api/requests/${requestId}/document?format=html`);assert.equal(html.status,200);assert.match(html.text,/Request and approval record/);
 assert.equal((await request(fixture('IT',false).app).get(`/api/requests/${requestId}/document`)).status,404);
 assert.equal((await request(fixture().app).get(`/api/requests/${requestId}/document?format=exe`)).status,400);
});

test('existing requests with SQL NULL or JSON null reviewer lists still open, print and download',async()=>{
 for(const empty of [null,'null','[]','']){
  const f=fixture('Admin',true,empty);
  const data=await request(f.app).get(`/api/requests/${requestId}`);assert.equal(data.status,200,JSON.stringify(data.body));assert.deepEqual(data.body.workflowSteps[0].eligibleApprovers,[]);
  const printed=await request(f.app).get(`/api/requests/${requestId}/document?format=html`);assert.equal(printed.status,200);assert.match(printed.text,/CITO actor/);
  const downloaded=await request(f.app).get(`/api/requests/${requestId}/document?format=pdf`);assert.equal(downloaded.status,200);assert.equal(downloaded.body.subarray(0,5).toString(),'%PDF-');
 }
});
