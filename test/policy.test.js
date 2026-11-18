import test from 'node:test';
import assert from 'node:assert/strict';
import {canReview,assertVersion,managerRole} from '../src/modules/requests/policy.js';
import {safeJson,parse} from '../src/core/validation.js';
import {createRequest,decision} from '../src/modules/requests/schemas.js';
import {actorId,otherId,branchId,departmentId,user} from './helpers.js';

test('review requires current role, branch/department, open status and separation of duties',()=>{
 const reviewer={...user,Role:'Branch manager'};const ticket={RequesterId:otherId,Status:'Pending'};const step={Role:'Branch manager',BranchId:branchId};
 assert.equal(canReview(ticket,step,reviewer),true);
 for(const invalid of [{...ticket,RequesterId:actorId},{...ticket,SubjectUserId:actorId},{...ticket,Status:'Approved'},{...ticket,Status:'Query'}])assert.equal(canReview(invalid,step,reviewer),false);
 assert.equal(canReview(ticket,{...step,BranchId:otherId},reviewer),false);
 assert.equal(canReview(ticket,{Role:'IT'},reviewer),false);
 assert.equal(canReview(ticket,{Role:'Department head',DepartmentId:otherId},{...reviewer,Role:'Department head'}),false);
});
test('stale row versions fail with a conflict',()=>{assert.doesNotThrow(()=>assertVersion({Version:Buffer.from('0000000000000001','hex')},'0000000000000001'));assert.throws(()=>assertVersion({Version:Buffer.from('0000000000000002','hex')},'0000000000000001'),error=>error.status===409);});
test('manager routing follows branch and head-office department policy',()=>{assert.equal(managerRole('Dhanmondi Branch','Operations'),'Branch manager');assert.equal(managerRole('Corporate Office','IT Department'),'Department head');assert.equal(managerRole('Gulshan Branch','Card Centre'),'Department head');});
test('form JSON rejects prototype pollution, embedded credentials, and excessive depth',()=>{
 assert.equal(safeJson(JSON.parse('{"__proto__":{"admin":true}}')),false);
 assert.equal(safeJson({newUserDetails:{password:'secret'}}),false);
 let nested={};for(let i=0;i<15;i++)nested={nested};assert.equal(safeJson(nested),false);
 assert.equal(safeJson({transferDetails:{businessReason:'Need access',systems:['ICBS']}}),true);
});
test('request schema validates normalized people, items, consent and rejects mass assignment',()=>{
 const input={typeCode:'upgrade',branchId,departmentId,justification:'Business access required',details:{upgradeDetails:{systems:['ICBS']}},people:[{employeeId:'TEST1',name:'Test User',branchId,departmentId}],items:[{employeeId:'TEST1',systemId:otherId,operation:'update'}],consent:true};
 assert.equal(parse(createRequest,input).people.length,1);
 assert.throws(()=>parse(createRequest,{...input,requesterId:otherId}));assert.throws(()=>parse(createRequest,{...input,consent:false}));
 assert.throws(()=>parse(decision,{version:'0000000000000001',decision:'reject'}));
});
