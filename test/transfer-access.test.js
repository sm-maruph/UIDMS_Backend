import test from 'node:test';import assert from 'node:assert/strict';
import {inventoryVersion,transferDifference,canonicalSelection,accessKey,assertTransferReviewed} from '../src/modules/requests/transfer-access.js';

test('transfer comparison records retained, removed, and new role-level access without changing snapshots',()=>{
 const current=[{systemId:'a',systemRoleId:'entry'},{systemId:'a',systemRoleId:'supervisor'},{systemId:'email',systemRoleId:null}];
 const requested=[current[0],{systemId:'c',systemRoleId:'operator'}];
 const result=transferDifference(current,requested);assert.deepEqual(result.kept,[current[0]]);assert.deepEqual(result.removed,[current[1],current[2]]);assert.deepEqual(result.added,[requested[1]]);
 assert.equal(inventoryVersion(current),inventoryVersion([...current].reverse()));assert.notEqual(inventoryVersion(current),inventoryVersion(requested));assert.equal(current.length,3);
});
test('transfer selections validate system/role membership, prevent role bypass and duplicates, and preserve inactive existing access',async()=>{
 const query=async()=>({recordsets:[[{Id:'a',Name:'System A',Active:true},{Id:'b',Name:'System B',Active:false}],[{Id:'entry',SystemId:'a',Name:'Entry',Active:true},{Id:'old',SystemId:'b',Name:'Old role',Active:false}]]});
 const item={systemId:'a',systemRoleId:'entry',reason:'Destination duties'};
 assert.equal((await canonicalSelection(query,[item],[]))[0].system,'System A');
 for(const items of [[{...item,systemRoleId:null}],[{...item,systemRoleId:'old'}],[item,item],[{...item,systemId:'missing'}]])await assert.rejects(canonicalSelection(query,items,[]));
 const old={systemId:'b',systemRoleId:'old',reason:'Still required'};assert.equal(accessKey((await canonicalSelection(query,[old],[old]))[0]),accessKey(old));
 await assert.rejects(canonicalSelection(query,[old],[]));
});

test('workflow changes cannot bypass IT review for newly requested destination access',()=>{
 const ticket={TypeCode:'movement',Details:JSON.stringify({transferAccess:{version:1,employeeDifference:{added:[{systemId:'new'}]},itReview:null}})};
 assert.throws(()=>assertTransferReviewed(ticket),error=>error.code==='TRANSFER_IT_REVIEW_REQUIRED');
 assert.doesNotThrow(()=>assertTransferReviewed({...ticket,Details:JSON.stringify({transferAccess:{version:1,employeeDifference:{added:[]}}})}));
});
