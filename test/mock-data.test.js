import test from 'node:test';
import assert from 'node:assert/strict';
import {mockUsers,sourceRequests,ticketPeople,ticketItems,typeCodes,approvalPlan} from '../scripts/mock-data/source.js';
import {mockModeEnabled,mockLoginAllowed} from '../src/modules/auth/mock-policy.js';
import {readConfig} from '../src/config.js';
import {testConfig} from './helpers.js';

test('fixture plan preserves all original identities and includes an extra test account and beneficiaries',()=>{
 const users=mockUsers();const ids=new Set(users.map(user=>user.employeeId));
 for(const user of users)assert.equal(typeof user.email,'string');
 for(const id of ['BD00411','BD00351','BNGL6191','BNGL0315','BD06619','BD00387','BD02072','BD00438','BD06653','MOCK001'])assert.ok(ids.has(id));
 assert.equal(ids.size,users.length);assert.equal(new Set(sourceRequests.map(ticket=>ticket.id)).size,sourceRequests.length);
 for(const ticket of sourceRequests){
  const requester=users.find(user=>user.employeeId===ticket.requesterId);assert.ok(requester);assert.ok(typeCodes[ticket.action]);
  const people=ticketPeople(ticket,requester);assert.ok(people.length);assert.ok(ticketItems(ticket,people).length||ticket.system==='Multiple systems','Only an explicitly unspecified legacy selection may omit normalized items.');
  for(const person of people)assert.ok(ids.has(person.employeeId));
  const plan=approvalPlan(ticket);assert.ok(plan.position>=1&&plan.position<=plan.roles.length);
 }
});
test('shared-password login is restricted to marked accounts, loopback and explicit development mode',()=>{
 const config={...testConfig,NODE_ENV:'development',MOCK_LOGIN_ENABLED:true,HOST:'127.0.0.1'};
 const req={socket:{remoteAddress:'127.0.0.1'}};
 assert.equal(mockLoginAllowed(config,req,{IsDemo:true}),true);
 assert.equal(mockLoginAllowed(config,req,{IsDemo:false}),false);
 assert.equal(mockLoginAllowed(config,{socket:{remoteAddress:'192.0.2.1'}},{IsDemo:true}),false);
 assert.equal(mockModeEnabled({...config,NODE_ENV:'production'}),false);
 assert.equal(mockModeEnabled({...config,MOCK_LOGIN_ENABLED:false}),false);
 assert.equal(mockModeEnabled({...config,HOST:'0.0.0.0'}),false);
});
test('production cannot start with mock login enabled',()=>{
 const env={...testConfig,NODE_ENV:'production',ALLOWED_ORIGINS:'https://uidms.example',DB_ENCRYPT:'true',DB_TRUST_CERTIFICATE:'false',COOKIE_SECURE:'true',MFA_REQUIRED:'true',MOCK_LOGIN_ENABLED:'true'};
 assert.throws(()=>readConfig(env),/Mock login is allowed only/);
});
