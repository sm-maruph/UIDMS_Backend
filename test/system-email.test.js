import test from 'node:test';
import assert from 'node:assert/strict';
import {groupEmailDrafts,validTemplate,variablesForService} from '../src/modules/fulfilment/system-email.js';
import {categoryForType} from '../src/modules/fulfilment/email-services.js';
import {mergeApprovalChains} from '../src/modules/requests/system-workflows.js';

test('service templates validate and render service-specific request fields',()=>{
 assert.equal(categoryForType('new-user'),'new-id');
 assert.equal(categoryForType('self-access'),'new-id');
 assert.equal(categoryForType('external-device'),'external');
 assert.equal(validTemplate('{{deviceModel}}',variablesForService('external')),true);
 assert.equal(validTemplate('{{deviceModel}}',variablesForService('reset')),false);
 const [draft]=groupEmailDrafts({TicketNumber:'UID-1',Action:'Mailing group change',Details:JSON.stringify({mailingGroupDetails:{action:'Exclusion',groupAddresses:['Operations','Help Desk'],profileEmail:'employee@example.com'}})},[
  {TemplateId:'mail',Recipients:'{"to":["team@example.com"],"cc":[]}',Subject:'{{groupAction}} {{ticketNumber}}',Body:'{{email}} / {{mailingGroups}}'},
 ]);
 assert.equal(draft.content.subject,'Exclusion UID-1');
 assert.equal(draft.content.body,'employee@example.com / Operations, Help Desk');
});

test('each draft includes only the approved employees, systems and roles for its email group',()=>{
 const request={TicketNumber:'UID-123',Action:'New system access'};
 const common={Name:'Taylor',EmployeeId:'E101',Operation:'grant',Branch:'Main',Department:'Operations'};
 const central={TemplateId:'central',TemplateName:'Central',Recipients:'{"to":["central@example.com"],"cc":[]}',Subject:'{{ticketNumber}} / {{system}}',Body:'{{items}}'};
 const digital={TemplateId:'digital',TemplateName:'Digital',Recipients:'{"to":["digital@example.com"],"cc":[]}',Subject:'{{ticketNumber}} / {{system}}',Body:'{{name}} / {{employeeId}} / {{systemId}}'};
 const [centralDraft,digitalDraft,fallback]=groupEmailDrafts(request,[
  {...common,...central,SystemName:'T4S',SystemId:'t4s',RoleName:'Teller'},
  {...common,...digital,Name:'Jordan',EmployeeId:'E102',SystemName:'WBO',SystemId:'wbo'},
  {...common,...central,SystemName:'ICBS',SystemId:'icbs',RoleName:'Inquiry'},
  {...common,TemplateId:null,SystemName:'Email',SystemId:'email'},
 ]).map(draft=>draft.content);
 assert.deepEqual(centralDraft.to,['central@example.com']);
 assert.deepEqual(centralDraft.systems,['T4S','ICBS']);
 assert.match(centralDraft.body,/Taylor \(E101\) \/ Role: Teller/);
 assert.doesNotMatch(centralDraft.body,/Jordan|WBO/);
 assert.equal(digitalDraft.body,'Jordan / E102 / wbo');
 assert.deepEqual(fallback.to,[]);
 assert.deepEqual(fallback.systems,['Email']);
 assert.equal(validTemplate('Read {{items}} and {{ role }}.'),true);
 assert.equal(validTemplate('Do not use {{unknown}}.'),false);
});

test('ticket-wide approval combines applicable steps and rejects conflicting order',()=>{
 const baseline=['Manager','IT','CITO','COO'];
 assert.deepEqual(mergeApprovalChains([baseline,['HR','IT','CITO','COO']]),['Manager','HR','IT','CITO','COO']);
 assert.deepEqual(mergeApprovalChains([['IT','CITO','COO']]),['IT','CITO','COO']);
 assert.throws(()=>mergeApprovalChains([baseline,['CITO','IT','COO']]),{code:'CONFLICTING_APPROVAL_CHAINS'});
});
