import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {groupEmailDrafts,readEmailDrafts,processingEmailFields} from '../src/modules/fulfilment/system-email.js';
import {fixedProcessingCc,requiredProcessingCc} from '../src/modules/fulfilment/email-recipients.js';
import {fulfilmentRoutes} from '../src/modules/fulfilment/routes.js';
import {errorHandler} from '../src/core/errors.js';
import {testConfig,user,actorId,otherId,requestId,branchId} from './helpers.js';

const requester='requester@combankbd.com';
const ticket={Id:requestId,RequesterId:otherId,RequesterSnapshot:JSON.stringify({email:requester}),TypeCode:'new-user',TicketNumber:'UID-1',Action:'New ID creation (on behalf)',Status:'Approved'};
const content={to:['team@combankbd.com'],cc:['existing@combankbd.com'],subject:'Approved request',body:'Process the approved access.'};
const item={TemplateId:branchId,Recipients:JSON.stringify(content),Subject:content.subject,Body:content.body,SystemName:'AD ID',Name:'Beneficiary',EmployeeId:'BDNEW',Operation:'grant'};

test('new-user template and general drafts copy the submitter and both fixed mailboxes without duplicates',()=>{
 const withDuplicates={...item,Recipients:JSON.stringify({...content,cc:[...content.cc,'SHAFI@COMBANKBD.COM',requester]})};
 const drafts=groupEmailDrafts({...ticket,Details:JSON.stringify({newUserDetails:{people:[{employeeId:'BDNEW',email:true,preferredEmail:'new.employee'}]}})},[withDuplicates,{...item,TemplateId:null}]);
 for(const draft of drafts){
  assert.deepEqual(draft.content.requiredCc,[...fixedProcessingCc,requester]);
  for(const address of [...fixedProcessingCc,requester])assert.equal(draft.content.cc.filter(value=>value===address).length,1);
  assert.equal(draft.content.cc.includes('new.employee@combankbd.com'),false);
 }
 assert.ok(drafts[0].content.cc.includes('existing@combankbd.com'));
});

test('requester CC uses the current directory email with snapshot fallback and does not invent a missing email',()=>{
 assert.deepEqual(requiredProcessingCc({...ticket,RequesterEmail:'CURRENT@combankbd.com'}),[...fixedProcessingCc,'current@combankbd.com']);
 for(const email of [undefined,null,'',true,'invalid','name@example.com\r\nBcc: attacker@example.com'])assert.deepEqual(requiredProcessingCc({RequesterSnapshot:JSON.stringify({email})}),fixedProcessingCc);
});

test('all twenty optional template CCs fit alongside the required three recipients',()=>{
 const cc=Array.from({length:20},(_,index)=>`person${index}@combankbd.com`);
 const [draft]=groupEmailDrafts(ticket,[{...item,Recipients:JSON.stringify({...content,cc})}]);
 assert.equal(draft.content.cc.length,23);assert.equal(processingEmailFields.safeParse(draft.content).success,true);
});

test('existing unsent drafts receive current required CCs while historical sent content is preserved',async()=>{
 const rows=[{Id:actorId,Content:JSON.stringify(content),SentAt:null},{Id:otherId,Content:JSON.stringify(content),SentAt:'2026-11-22'}];
 const drafts=await readEmailDrafts(async()=>({recordset:rows}),requestId,ticket);
 assert.deepEqual(drafts[0].cc,[...fixedProcessingCc,requester,...content.cc]);
 assert.deepEqual(drafts[1].cc,content.cc);assert.equal(drafts[1].requiredCc,undefined);
});

function fixture(role='IT'){
 const calls=[];
 const query=async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT r.*'))return {recordset:[ticket]};
  if(sql.startsWith('SELECT Content,SentAt'))return {recordset:[{Content:JSON.stringify(content),SentAt:null}]};
  if(sql.startsWith('SELECT d.Id,d.Content'))return {recordset:[{Id:actorId,Content:JSON.stringify(content),SentAt:null}]};
  return {recordset:[]};
 };
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={...user,Role:role};next();});
 app.use(fulfilmentRoutes({query,transaction:work=>work(query)},testConfig));app.use(errorHandler);
 return {app,calls};
}

test('HTTP reads and sent confirmations enforce required recipients even when the client removes them',async()=>{
 const {app,calls}=fixture();
 const response=await request(app).get(`/requests/${requestId}/email-drafts`);assert.equal(response.status,200);assert.ok(response.body.items[0].cc.includes(requester));
 const sent=await request(app).post(`/requests/${requestId}/email-drafts/${actorId}/sent`).send({confirmedSent:true,email:{...content,cc:[]}});assert.equal(sent.status,204);
 const update=calls.find(call=>call.sql.startsWith('UPDATE dbo.RequestEmailDrafts'));
 assert.deepEqual(JSON.parse(update.params.content.value).cc,[...fixedProcessingCc,requester]);
 const ordinary=fixture('User');assert.equal((await request(ordinary.app).get(`/requests/${requestId}/email-drafts`)).status,403);assert.equal(ordinary.calls.length,0);
});

test('CC header injection is rejected before any draft is updated',async()=>{
 const {app,calls}=fixture();
 const response=await request(app).post(`/requests/${requestId}/email-drafts/${actorId}/sent`).send({confirmedSent:true,email:{...content,cc:['safe@combankbd.com\r\nBcc: attacker@example.com']}});
 assert.equal(response.status,400);assert.equal(calls.length,0);
});
