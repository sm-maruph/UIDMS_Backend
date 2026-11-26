import test from 'node:test';import assert from 'node:assert/strict';
import {requestDocument,documentHtml} from '../src/modules/requests/document.js';
import {documentPdf} from '../src/modules/requests/document-pdf.js';
import {jobDesignation} from '../src/modules/requests/document-designation.js';

const detail={ticketNumber:'UID-DESIGNATION',name:'Employee',requesterId:'BD001',requesterDesignation:'Senior Officer',typeCode:'reset',state:'Approved',branch:'Head Office BD',department:'IT Department',createdAt:'2026-11-26T08:00:00Z',requesterProfile:{employeeId:'BD001',role:'Super Admin'},people:[{employeeId:'BD001',name:'Employee',designation:'Senior Officer',details:{designation:'Super Admin'}},{employeeId:'BD002',name:'New employee',details:{designation:'Trainee'}}],details:{submittedForm:{data:{requesterProfile:{employeeId:'BD001',role:'Super Admin',designation:'Super Admin'},resetDetails:{employeeId:'BD001',designation:'Super Admin'},newUserDetails:{people:[{employeeId:'BD002',designation:'Trainee'}]}}}},workflowSteps:[],items:[]};
test('print and PDF use job designations instead of a requester’s portal permissions',async()=>{
 const report=requestDocument(detail,{Name:'Document generator',Role:'Super Admin'});
 assert.equal(report.requester.designation,'Senior Officer');assert.equal(report.people[0].designation,'Senior Officer');assert.equal(report.people[1].designation,'Trainee');
 const designations=report.fields.filter(row=>row.label.endsWith('Designation'));assert.equal(designations.length,3);assert.deepEqual(designations.map(row=>row.value),['Senior Officer','Senior Officer','Trainee']);
 const html=documentHtml(report);assert.match(html,/<strong>Designation<\/strong> Senior Officer/);assert.match(html,/<th>Designation<\/th>/);assert.equal(/Designation<\/td><td>Super Admin<\/td>/.test(html),false);
 const pdf=await documentPdf(report);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
});
test('a missing job designation is never inferred from a UIDMS role',()=>{
 const report=requestDocument({...detail,requesterDesignation:null,people:[],details:{designation:'Super Admin'}},{Role:'Super Admin'});
 assert.equal(report.requester.designation,'Not recorded');assert.equal(report.fields.find(row=>row.label==='Designation').value,'Not recorded');
 for(const value of ['Super Admin','Admin','Platform Admin','User'])assert.equal(jobDesignation(value),'');
 for(const value of ['Officer','Senior Officer','CEO','COO','Trainee'])assert.equal(jobDesignation(value),value);
});
test('legitimate submitted titles remain historical even if the employee’s current job changed',()=>{
 const report=requestDocument({...detail,requesterProfile:{designation:'Officer',role:'Super Admin'},details:{designation:'Officer'}},{Role:'Admin'});
 assert.equal(report.requester.designation,'Officer');assert.equal(report.fields[0].value,'Officer');
});

test('an old role-valued designation lookup falls back to the corrected directory title',()=>{
 const report=requestDocument({...detail,requesterDesignation:'Super Admin',requesterCurrentDesignation:'Officer',people:[{employeeId:'BD001',designation:'Super Admin',currentDesignation:'Officer',details:{designation:'Super Admin'}}]},{});
 assert.equal(report.requester.designation,'Officer');assert.equal(report.people[0].designation,'Officer');assert.ok(report.fields.filter(row=>row.label.endsWith('Designation')).every(row=>row.value!=='Super Admin'));
});
