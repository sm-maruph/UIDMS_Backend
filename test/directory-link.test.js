import test from 'node:test';
import assert from 'node:assert/strict';
import {linkDirectoryIdentity} from '../src/modules/auth/directory-link.js';
import {user,actorId,otherId} from './helpers.js';
const identity={systemId:'ad:test:'+Buffer.alloc(16,3).toString('hex'),employeeId:'TEST1'};
function fixture({demo=false,links=[]}={}){
 const calls=[];const db={transaction:work=>work(async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT Id,EmployeeId,Role'))return {recordset:[{...user,IsDemo:demo}]};
  if(sql.startsWith('SELECT SystemId,UserId'))return {recordset:links};
  return {recordset:[]};
 })};return {db,calls};
}
const req={id:otherId,ip:'admin-cli'};
test('manual AD linking binds only the verified matching identity, preserves roles and revokes previous sessions',async()=>{
 const {db,calls}=fixture();const result=await linkDirectoryIdentity(db,identity,'TEST1',req);
 assert.equal(result.convertedMock,false);assert.ok(calls.some(call=>call.sql.startsWith('INSERT dbo.DirectoryIdentities')));
 assert.ok(calls.some(call=>call.sql.includes('UPDATE dbo.Sessions SET RevokedAt')));
 assert.equal(calls.some(call=>call.sql.includes('SET Role=')),false);
 assert.ok(calls.some(call=>call.params?.event?.value==='auth.directory_linked'));
});
test('mock conversion requires explicit operator intent and removes the shared password',async()=>{
 const f=fixture({demo:true,links:[{SystemId:'TEST1',UserId:actorId}]});
 await assert.rejects(linkDirectoryIdentity(f.db,identity,'TEST1',req),error=>error.code==='MOCK_CONVERSION_REQUIRED');
 assert.equal(f.calls.some(call=>/^(INSERT|UPDATE)/.test(call.sql)),false);
 const g=fixture({demo:true,links:[{SystemId:'TEST1',UserId:actorId}]});
 const converted=await linkDirectoryIdentity(g.db,identity,'TEST1',req,{convertMock:true});assert.equal(converted.convertedMock,true);
 assert.ok(g.calls.some(call=>call.sql.includes('IsDemo=0,PasswordHash=NULL')));
});
test('linking rejects a different employee ID, an identity owned by another profile and unconfirmed relinking',async()=>{
 const first=fixture();await assert.rejects(linkDirectoryIdentity(first.db,identity,'OTHER1',req),error=>error.code==='EMPLOYEE_ID_MISMATCH');assert.equal(first.calls.length,0);
 const second=fixture({links:[{SystemId:identity.systemId,UserId:otherId}]});await assert.rejects(linkDirectoryIdentity(second.db,identity,'TEST1',req),error=>error.code==='DIRECTORY_IDENTITY_ALREADY_LINKED');
 const third=fixture({links:[{SystemId:'ad:test:'+Buffer.alloc(16,4).toString('hex'),UserId:actorId}]});await assert.rejects(linkDirectoryIdentity(third.db,identity,'TEST1',req),error=>error.code==='REPLACE_LINK_REQUIRED');
 for(const f of [second,third])assert.equal(f.calls.some(call=>/^(INSERT|UPDATE)/.test(call.sql)),false);
});
