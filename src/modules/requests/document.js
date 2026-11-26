import {currentRequestTypes} from './catalog.js';
import {bankLogoData,uidmsLogoData,formTitle,formInstruction} from './document-branding.js';

const hidden=/password|secret|credential|csrf|token|signature|^mockSource$/i;
const label=value=>String(value).replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/^./,value=>value.toUpperCase());
export const documentTime=value=>value&&Number.isFinite(+new Date(value))?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Dhaka'}).format(new Date(value)):'-';
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function fields(value,path='',rows=[]){
 if(value===null||value===undefined||value==='')return rows;
 if(typeof value!=='object'){if(typeof value!=='string'||!value.startsWith('data:'))rows.push({label:path||'Value',value:typeof value==='boolean'?(value?'Yes':'No'):String(value)});return rows;}
 for(const [key,item] of Object.entries(value))if(!hidden.test(key)&&key!=='submittedForm')fields(item,path?`${path} / ${Array.isArray(value)?Number(key)+1:label(key)}`:label(key),rows);
 return rows;
}
export function requestDocument(detail,actor,now=new Date()){
 const steps=detail.workflowSteps||[],last=Math.max(0,...steps.map(step=>step.position));
 const entries=step=>({name:step.by||step.assignedName||'Not yet assigned',at:step.at||null,status:step.status==='Approved'?(step.position===last?'Approved':'Recommended'):step.status==='Rejected'?'Rejected':'Pending',remark:step.remark||''});
 const approvals=[{role:'Requester',entries:[{name:detail.name,at:detail.createdAt,status:'Submitted'}]}];
 for(const [role,match] of [['Branch manager / Department head',['Manager','Branch manager','Department head']],['HR',['HR']],['IT',['IT']],['CITO',['CITO']],['COO',['COO']]]){
  const matching=steps.filter(step=>match.includes(step.role));if(matching.length)approvals.push({role,entries:matching.map(entries)});
 }
 const fulfilment=detail.fulfilment;
 if(fulfilment?.ActorName&&(fulfilment.CompletedAt||fulfilment.ProcessingAt)){
  let it=approvals.find(item=>item.role==='IT');if(!it){it={role:'IT / Processing',entries:[]};const index=approvals.findIndex(item=>['CITO','COO'].includes(item.role));if(index===-1)approvals.push(it);else approvals.splice(index,0,it);}
  it.entries.push({name:fulfilment.ActorName,at:fulfilment.CompletedAt||fulfilment.ProcessingAt,status:fulfilment.CompletedAt?'Completed processing':'Processing'});
 }
 const original=detail.details?.submittedForm?.data||detail.details||{};
 const serviceFields=fields(original);
 fields((detail.hrClearance||[]).map(row=>({employee:detail.people?.find(person=>person.id===row.PersonId)?.name||row.PersonId,police:row.Police,referenceCheck:row.ReferenceCheck,recommendation:row.Recommendation,updatedAt:documentTime(row.UpdatedAt)})),'HR clearance',serviceFields);
 if(fulfilment)fields({reference:fulfilment.ProcessingReference,notes:fulfilment.Notes},'Processing',serviceFields);
 return {ticket:detail.ticketNumber,title:detail.typeCode==='new-user'?'New AD request':currentRequestTypes[detail.typeCode]||detail.action,status:detail.state,requiresJustification:detail.typeCode!=='reset',
  requester:{name:detail.name,employeeId:detail.requesterId,branch:detail.branch,department:detail.department,at:detail.createdAt},justification:detail.justification,
  people:detail.people||[],items:detail.items||[],fields:serviceFields,approvals,
  decisions:steps.filter(step=>step.status!=='Waiting').map(step=>({role:step.role,...entries(step)})),
  queries:(detail.queries||[]).map(row=>({by:row.by,to:row.recipient,message:row.message,at:row.at,response:row.response,responseAt:row.responseAt})),
  attachments:(detail.attachments||[]).map(row=>({name:row.OriginalName,status:row.ScanStatus,at:row.CreatedAt})),
  generatedAt:now.toISOString(),generatedBy:actor.Name||actor.name||actor.EmployeeId||'UIDMS'};
}
export function documentHtml(report){
 const e=escapeHtml;
 const table=(headers,rows)=>`<table><thead><tr>${headers.map(value=>`<th>${e(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(value=>`<td>${e(value||'-')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
 return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(report.ticket)} - CBC UIDMS</title><style>
 *{box-sizing:border-box}body{font:12px Arial,sans-serif;color:#152e47;background:#fff;margin:0;padding:24px}main{max-width:1050px;margin:auto}.form-header{border:1px solid #cdddf3;border-radius:6px;padding:12px;margin-bottom:18px;break-inside:avoid}.form-brand-row{display:grid;grid-template-columns:140px minmax(0,1fr) 140px;align-items:center;gap:16px;border-bottom:1px solid #cdddf3;padding:0 0 10px;margin-bottom:10px;min-height:45px}.form-brand-row img{display:block;width:125px;height:40px;object-fit:contain}.form-brand-row .bank-logo{justify-self:end}.bank-heading{text-align:center;color:#122e4b;font-size:18px;font-weight:700;line-height:1.3}.bank-heading small{display:block;font-size:11px;font-weight:400;color:#627388;margin-top:4px}.form-header h1{font-size:15px;line-height:1.4;color:#163a5d;margin:0 0 5px}.form-instruction{font-size:11px;color:#627388;margin:0;line-height:1.5}h2{font-size:13px;margin-top:20px;padding-bottom:6px;border-bottom:1px solid #cbd6e2}p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.meta{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 20px}.meta strong{display:inline-block;min-width:100px}table{width:100%;border-collapse:collapse;margin:10px 0;table-layout:fixed}th,td{text-align:left;border:1px solid #cbd6e2;padding:7px;overflow-wrap:anywhere;white-space:pre-wrap;vertical-align:top}th{background:#eef3fa;color:#2859a6}thead{display:table-header-group}tr{break-inside:avoid}.signoffs{display:grid;grid-template-columns:repeat(${report.approvals.length},minmax(0,1fr));gap:14px;margin:30px 0;break-inside:avoid}.signoff{padding-top:8px;border-top:1px solid #526a83;font-size:10px;overflow-wrap:anywhere}.signoff strong{display:block;font-size:11px;margin-bottom:8px}.signoff p{margin:5px 0}.muted{font-size:10px;color:#627388}footer{border-top:1px solid #cbd6e2;margin-top:24px;padding-top:10px;font-size:10px;color:#627388}@page{size:A4 landscape;margin:14mm}@media print{body{padding:0;font-size:10px}h2{break-after:avoid}.signoffs{gap:10px}.signoff{font-size:9px}}
 </style></head><body><main><header class="form-header"><div class="form-brand-row"><img class="uidms-logo" src="${uidmsLogoData}" alt="UIDMS - User Identity Management"><div class="bank-heading">Commercial Bank of Ceylon PLC<small>Bangladesh Operations</small></div><img class="bank-logo" src="${bankLogoData}" alt="Commercial Bank"></div><h1>${e(formTitle(report))}</h1><p class="form-instruction">${e(formInstruction(report))}</p></header>
 <section class="meta"><div><strong>Ticket</strong> ${e(report.ticket)}</div><div><strong>Status</strong> ${e(report.status)}</div></section>
 <section class="meta">${[['Requested by',report.requester.name],['Employee ID',report.requester.employeeId],['Branch',report.requester.branch],['Department',report.requester.department],['Request time',documentTime(report.requester.at)],['Generated by',report.generatedBy]].map(([key,value])=>`<div><strong>${e(key)}</strong> ${e(value)}</div>`).join('')}</section>
 <h2>Employees / beneficiaries</h2>${table(['Name','Employee ID'],report.people.map(row=>[row.name,row.employeeId]))}
 <h2>Requested systems and roles</h2>${table(['System','Role','Operation','Reason'],report.items.map(row=>[row.system,row.role,row.operation,row.reason]))}
 ${report.justification?`<h2>Business justification / Remarks</h2><p>${e(report.justification)}</p>`:''}
 ${report.fields.length?`<h2>Submitted request details</h2>${table(['Field','Value'],report.fields.map(row=>[row.label,row.value]))}`:''}
 ${report.decisions.length?`<h2>Review decisions and remarks</h2>${table(['Role','Name','Decision','Time (Dhaka)','Remarks'],report.decisions.map(row=>[row.role,row.name,row.status,documentTime(row.at),row.remark]))}`:''}
 ${report.queries.length?`<h2>Queries and responses</h2>${table(['From / To','Query','Time (Dhaka)','Response'],report.queries.map(row=>[`${row.by} / ${row.to}`,row.message,documentTime(row.at),row.response?`${row.response}\n${documentTime(row.responseAt)}`:'Awaiting response']))}`:''}
 ${report.attachments.length?`<h2>Supporting documents</h2>${table(['Name','Scan status','Uploaded (Dhaka)'],report.attachments.map(row=>[row.name,row.status,documentTime(row.at)]))}`:''}
 <h2>Request and approval record</h2><div class="signoffs">${report.approvals.map(slot=>`<section class="signoff"><strong>${e(slot.role)}</strong>${slot.entries.map(entry=>`<p>${e(entry.name)}<br>${e(entry.status)}<br>${e(documentTime(entry.at))}</p>`).join('')}</section>`).join('')}</div><p class="muted">Names and timestamps reflect recorded actions. Pending entries are not completed approvals. Times: Asia/Dhaka.</p><footer>CBC internal portal / Generated ${e(documentTime(report.generatedAt))} by ${e(report.generatedBy)}</footer></main></body></html>`;
}
