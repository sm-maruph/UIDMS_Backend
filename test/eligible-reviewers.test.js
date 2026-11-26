import test from 'node:test';import assert from 'node:assert/strict';import {eligibleReviewerRows,currentStep,details} from '../src/modules/requests/repository.js';import {canReview} from '../src/modules/requests/policy.js';import {user,otherId,requestId} from './helpers.js';

test('null, malformed and non-array reviewer results fail closed',()=>{
 for(const value of [null,undefined,'null','',false,'{}','invalid','[null,{},"actor"]'])assert.deepEqual(eligibleReviewerRows(value),[]);
 const row={UserId:otherId,Name:'Eligible actor'};assert.deepEqual(eligibleReviewerRows(JSON.stringify([row])),[row]);assert.deepEqual(eligibleReviewerRows([row]),[row]);
});

test('an empty authoritative reviewer list does not fall back to an assigned user or broad role',async()=>{
 const actor={...user,Role:'IT'},ticket={Id:requestId,RequesterId:otherId,Status:'Pending',CurrentPosition:1,Version:Buffer.alloc(8),Details:'{}',RequesterSnapshot:'{}'};
 const waiting={Position:1,Role:'IT',Status:'Waiting',AssignedUserId:actor.Id,EligibleReviewers:null};
 const step=await currentStep(async()=>({recordset:[waiting]}),ticket);assert.deepEqual(step.EligibleReviewerIds,[]);assert.equal(canReview(ticket,step,actor),false);
 let count=0;const result=await details(async()=>{count++;return{recordsets:[[],[],[{...waiting}],[],[],[],[]]};},ticket,actor);
 assert.equal(result.reviewableByMe,false);assert.deepEqual(result.workflowSteps[0].eligibleApprovers,[]);assert.equal(count,1);
});
