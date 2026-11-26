import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {notificationRoutes} from '../src/modules/notifications/routes.js';
import {notifyAttention} from '../src/modules/notifications/attention.js';
import {errorHandler} from '../src/core/errors.js';
import {actorId,otherId,requestId} from './helpers.js';

function fixture(){
 const calls=[];
 const db={query:async(text,params)=>{
  calls.push({text,params});
  if(text.includes('SELECT TOP(100)'))return {recordsets:[params.after.value?[{Id:'9007199254740993',Message:'Approval required'}]:[],[{latestId:'9007199254740995'}],[{unread:12,archivedTotal:33}]]};
  return {recordsets:[[{Total:29}],[{Id:'12',Message:'Request update'}],[{unread:12,archivedTotal:33}]]};
 }};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={Id:actorId};next();});app.use(notificationRoutes(db));app.use(errorHandler);
 return {app,calls};
}
test('notification pages are bounded, default to the rolling month, count all unread, and isolate the signed-in user',async()=>{
 const f=fixture(),response=await request(f.app).get('/notifications?page=3&pageSize=8');
 assert.equal(response.status,200);assert.equal(response.body.scope,'recent');assert.equal(response.body.unread,12);assert.equal(response.body.total,29);
 const {text,params}=f.calls[0];assert.equal(params.user.value,actorId);assert.equal(params.offset.value,16);assert.equal(params.size.value,8);
 assert.match(text,/n.UserId=@user/);assert.match(text,/CreatedAt>=DATEADD\(month,-1,@now\)/);assert.match(text,/r.DeletedAt IS NULL/);assert.match(text,/ORDER BY n.CreatedAt DESC,n.Id DESC OFFSET/);
 assert.equal((await request(f.app).get(`/notifications?userId=${otherId}`)).status,400);
});
test('archive is explicitly selected and reads older rows without deleting or changing dates',async()=>{
 const f=fixture(),response=await request(f.app).get('/notifications?scope=archived');assert.equal(response.status,200);
 assert.match(f.calls[0].text,/AND NOT \(n.CreatedAt>=DATEADD\(month,-1,@now\)\)/);assert.doesNotMatch(f.calls[0].text,/DELETE|UPDATE/);
 for(const path of ['/notifications?scope=all','/notifications?page=0','/notifications?pageSize=101'])assert.equal((await request(f.app).get(path)).status,400);
});
test('feed initializes silently, preserves bigint IDs and advances only to the last returned row',async()=>{
 const f=fixture(),first=await request(f.app).get('/notifications/feed');assert.equal(first.status,200);assert.deepEqual(first.body.items,[]);assert.equal(first.body.cursor,'9007199254740995');
 const next=await request(f.app).get('/notifications/feed?after=9007199254740992');assert.equal(next.status,200);assert.equal(next.body.cursor,'9007199254740993');assert.equal(f.calls[1].params.after.value,'9007199254740992');
 assert.match(f.calls[1].text,/ORDER BY n.Id;/);
 for(const after of ['-1','1 OR 1=1','9223372036854775808'])assert.equal((await request(f.app).get('/notifications/feed').query({after})).status,400);
});
test('read receipts can only update the current user’s notification',async()=>{
 const f=fixture();assert.equal((await request(f.app).post('/notifications/123/read').send({userId:otherId})).status,204);
 assert.match(f.calls[0].text,/WHERE Id=@id AND UserId=@user/);assert.equal(f.calls[0].params.user.value,actorId);
 assert.equal((await request(f.app).post('/notifications/1%20OR%201=1/read').send({})).status,400);
});
test('attention notifications use canonical scoped reviewer/acting authority and final-step labels',async()=>{
 const calls=[];await notifyAttention(async(text,params)=>{calls.push({text,params});return {recordset:text.startsWith('SELECT DISTINCT')?[{Id:otherId,TicketNumber:'UID-TEST',Attention:'recommendation required'}]:[]};},requestId);
 assert.match(calls[0].text,/uidms_StepReviewers/);assert.match(calls[0].text,/u.Id<>r.RequesterId/);assert.match(calls[0].text,/s.Status='Waiting'/);assert.match(calls[0].text,/later.Position>r.CurrentPosition/);assert.match(calls[0].text,/uidms_EffectiveRoles/);
 assert.equal(calls[1].params.user.value,otherId);assert.equal(calls[1].params.request.value,requestId);assert.equal(calls[1].params.message.value,'UID-TEST: recommendation required.');
});
