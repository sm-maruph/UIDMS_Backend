// Portal permissions are not an employee's professional designation. Never
// invent a job title from a UIDMS role, including incorrectly imported old forms.
export function jobDesignation(value){
 if(typeof value!=='string')return '';
 const title=value.trim();
 return /^(?:super\s*admin(?:istrator)?|platform\s*admin(?:istrator)?|admin(?:istrator)?|user)$/i.test(title)?'':title;
}

export function documentDesignations(detail){
 const requester=String(detail.requesterId||detail.requesterProfile?.employeeId||'').toLowerCase();
 const designation=jobDesignation(detail.requesterProfile?.designation)||jobDesignation(detail.requesterDesignation)||jobDesignation(detail.requesterCurrentDesignation);
 const people=(detail.people||[]).map(person=>({...person,designation:jobDesignation(person.details?.designation)||jobDesignation(person.designation)||jobDesignation(person.currentDesignation)||((person.employeeId||'').toLowerCase()===requester?designation:'')}));
 const titles=new Map(people.map(person=>[String(person.employeeId||'').toLowerCase(),person.designation]));
 if(requester)titles.set(requester,designation);
 const normalize=(value,employee=requester)=>{
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(item=>normalize(item,employee));
  const owner=String(value.employeeId||employee).toLowerCase();
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='designation'?(jobDesignation(item)||titles.get(owner)||'Not recorded'):normalize(item,key==='requesterProfile'?requester:owner)]));
 };
 return {designation,people,original:normalize(detail.details?.submittedForm?.data||detail.details||{})};
}
