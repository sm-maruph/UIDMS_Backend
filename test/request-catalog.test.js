import test from 'node:test';
import assert from 'node:assert/strict';
import {currentRequestTypes,portalRequestTypes,retiredRequestType} from '../src/modules/requests/catalog.js';
import {createTicket} from '../src/modules/requests/service.js';
import express from 'express';
import request from 'supertest';
import {directoryRoutes} from '../src/modules/directory/routes.js';
import {testConfig,user} from './helpers.js';
test('portal configuration contains exactly the current submitted services with matching labels',()=>{
 const rows=[...Object.keys(currentRequestTypes),'batch-access','branch-transfer','new-id','unknown'].map(Code=>({Code,Name:'Old label',IncludesHr:false}));
 const result=portalRequestTypes(rows);assert.equal(result.length,13);assert.equal(result.find(row=>row.Code==='movement').Name,'Branch / Department Transfer');assert.equal(result.find(row=>row.Code==='upgrade').Name,'ID Role Upgrade');
 assert.equal(result.some(row=>retiredRequestType(row.Code)),false);assert.equal(rows[0].Name,'Old label');
});
test('historical configuration and aggregate counts are limited to administrators',async()=>{
 for(const Role of ['User','Admin']){
  let params;
  const db={query:async(sql,values)=>{params=values;return {recordsets:[[],[],[],[{Code:'batch-access',Name:'Batch access request',InitiatorRoles:'["User"]',ExistingRequests:12}],[],[]]};}};
  const app=express();app.use((req,res,next)=>{req.user={...user,Role};next();});app.use(directoryRoutes(db,testConfig));
  const response=await request(app).get('/lookups');assert.equal(response.status,200);assert.equal(params.catalogAdmin.value,Role==='Admin');assert.equal(response.body.requestTypes.length,0);assert.equal(response.body.legacyRequestTypes.length,Role==='Admin'?1:0);
 }
});
test('retired services cannot create new records, while their historical data is not mutated',async()=>{
 for(const typeCode of ['batch-access','new-id','branch-transfer']){
  await assert.rejects(createTicket({transaction:work=>work(()=>{throw new Error('Must not query or mutate business data.');})},{},{typeCode}),error=>error.code==='REQUEST_TYPE_RETIRED');
 }
});
