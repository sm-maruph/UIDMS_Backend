import {initialUsers} from '../../../frontend/src/components/mockUsers.js';
import {mockRequests} from '../../../frontend/src/components/mockRequests.js';
import {fulfilmentItems} from '../../../frontend/src/components/fulfilment.js';

export const typeCodes={'New ID creation':'new-id','System ID creation (self-request)':'self-access','New ID creation (on behalf)':'new-user','ID reset / unlock':'reset','ID upgrade':'upgrade','Branch transfer':'branch-transfer','Branch / Department change':'movement','Email creation':'email','External device email access':'external-device','Employee ID deactivation':'employee-deactivate','System ID deactivation':'system-deactivate','Auto-forward change':'auto-forward','Mailing group change':'mailing-group','IDrive access':'idrive','N Drive access':'n-drive'};
export const sourceRequests=structuredClone(mockRequests);
export function ticketPeople(ticket,requester){
 const listed=ticket.newUserDetails?.people||ticket.batchDetails?.people||ticket.transferDetails?.people;
 const rows=listed?.length?listed:ticket.deactivationDetails?.employeeId?[ticket.deactivationDetails]:[requester];
 return rows.map(row=>({...row,employeeId:row.employeeId||requester.employeeId,name:row.name||row.fullName||requester.name,branch:row.branch||row.toBranch||ticket.branch||requester.branch,department:row.department||requester.department||'Operations'}));
}
export function mockUsers(){
 const users=new Map(initialUsers.map(user=>[user.employeeId,structuredClone(user)]));
 for(const ticket of sourceRequests){
  const requester=users.get(ticket.requesterId);
  if(!requester)throw new Error(`Missing source requester ${ticket.requesterId}`);
  for(const person of ticketPeople(ticket,requester))if(!users.has(person.employeeId))users.set(person.employeeId,{...person,role:'User',systemId:person.userId||person.employeeId,designation:person.designation||'Officer',access:{systemRoles:{},enabledSystems:[],otherAccess:[]}});
 }
 users.set('MOCK001',{employeeId:'MOCK001',systemId:'MOCK001',name:'Mock Test User',email:'mock001@combankbd.com',role:'User',branch:'Dhanmondi Branch',department:'Operations',designation:'Officer',access:{systemRoles:{},enabledSystems:[],otherAccess:[]}});
 return [...users.values()].map(user=>({...user,email:typeof user.email==='string'&&user.email.includes('@')?user.email:`${user.employeeId.toLowerCase()}@combankbd.com`,systemId:user.systemId||user.employeeId}));
}
export function ticketItems(ticket,people){
 const rows=fulfilmentItems(ticket);
 const result=[];
 for(const person of people){
  const own=rows.filter(row=>row.employeeId===person.employeeId);
  const relevant=own.length?own:rows;
  for(const item of relevant){
   const systems=item.system==='All systems'?['AD ID','Email']:String(item.system||'').split(/,\s*| \+ /);
   for(const system of systems)if(system&&system!=='Multiple systems'&&system!=='Request service')result.push({...item,system,employeeId:person.employeeId});
  }
 }
 return [...new Map(result.map(row=>[`${row.employeeId}:${row.system}:${row.role||''}`,row])).values()];
}
export function approvalPlan(ticket){
 const roles=ticket.action==='ID reset / unlock'?['CITO']:['Branch manager',...(['new-user','branch-transfer','employee-deactivate'].includes(typeCodes[ticket.action])?['HR']:[]),'IT','CITO','COO'];
 for(const event of ticket.approvalHistory||[])if(event.role&&!roles.includes(event.role))roles.splice(0,0,event.role);
 const owner=ticket.state==='Query'?ticket.queryReturnRole:ticket.assignedRole;
 if(owner&&!roles.includes(owner))roles.push(owner);
 return {roles,position:owner?roles.indexOf(owner)+1:roles.length};
}
