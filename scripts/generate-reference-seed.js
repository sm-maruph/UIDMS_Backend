// Development-only generator. Production uses the committed standalone SQL file.
import {writeFile} from 'node:fs/promises';
import {requestRoles,formResetSystems} from '../../frontend/src/components/requestCatalog.js';
import {defaultDepartments} from '../../frontend/src/components/departments.js';
import {defaultDesignations} from '../../frontend/src/components/designations.js';
const q=value=>`N'${value.replaceAll("'","''")}'`;
const roles=['User','Branch manager','Department head','IT','CITO','COO','HR','Platform Admin','Super Admin'];
const types=[
 ['new-id','New ID creation',['Manager','IT','CITO','COO']],
 ['new-user','New ID creation (on behalf)',['Manager','HR','IT','CITO','COO']],
 ['self-access','System ID creation (self-request)',['Manager','IT','CITO','COO']],
 ['reset','Unlock / Reset',['CITO']],
 ['upgrade','ID upgrade',['Manager','IT','CITO','COO']],
 ['branch-transfer','Branch transfer',['Manager','HR','IT','CITO','COO']],
 ['movement','Branch / Department Transfer',['Manager','HR','IT','CITO','COO']],
 ['email','Email creation',['Manager','IT','CITO','COO']],
 ['external-device','External device email access',['Manager','IT','CITO','COO']],
 ['employee-deactivate','Employee ID deactivation',['Manager','HR','IT','CITO','COO']],
 ['system-deactivate','System ID deactivation',['Manager','IT','CITO','COO']],
 ['auto-forward','Auto-forward change',['Manager','IT','CITO','COO']],
 ['mailing-group','Mailing group change',['Manager','IT','CITO','COO']],
 ['batch-access','Batch access request',['Manager','IT','CITO','COO']],
 ['idrive','I Drive / S Drive Access',['Manager','IT','CITO','COO']],
 ['n-drive','N Drive Access',['Manager','IT','CITO','COO']],
];
const lines=['USE CBC_UIDMS;','GO','SET XACT_ABORT ON;','BEGIN TRANSACTION;'];
for(const role of roles)lines.push(`IF NOT EXISTS(SELECT 1 FROM dbo.PortalRoles WHERE Name=${q(role)}) INSERT dbo.PortalRoles(Name) VALUES(${q(role)});`);
for(const [kind,names] of [['branch',['Agrabad Branch','Dhanmondi Branch','Gulshan Branch','Banani Branch','Corporate Office','Head Office']],['department',[...defaultDepartments,'Operations','IT Department','HR Department']],['designation',defaultDesignations]]){
 for(const name of new Set(names))lines.push(`IF NOT EXISTS(SELECT 1 FROM dbo.Lookups WHERE Kind='${kind}' AND Name=${q(name)}) INSERT dbo.Lookups(Kind,Name) VALUES('${kind}',${q(name)});`);
}
for(const [name,systemRoles] of Object.entries({...requestRoles,'MS Office':[]})){
 lines.push(`IF NOT EXISTS(SELECT 1 FROM dbo.Systems WHERE Name=${q(name)}) INSERT dbo.Systems(Name) VALUES(${q(name)});`);
 lines.push(`UPDATE dbo.Systems SET TransferManaged=${formResetSystems.includes(name)&&name!=='AD ID'?1:0} WHERE Name=${q(name)};`);
 for(const role of systemRoles)lines.push(`IF NOT EXISTS(SELECT 1 FROM dbo.SystemRoles sr JOIN dbo.Systems s ON s.Id=sr.SystemId WHERE s.Name=${q(name)} AND sr.Name=${q(role)}) INSERT dbo.SystemRoles(SystemId,Name) SELECT Id,${q(role)} FROM dbo.Systems WHERE Name=${q(name)};`);
}
for(const [code,name,flow] of types){
 const allowed=['movement','branch-transfer'].includes(code)?['IT','HR']:code==='employee-deactivate'?['IT','HR']:roles.filter(role=>!role.includes('Admin'));
 lines.push(`IF NOT EXISTS(SELECT 1 FROM dbo.RequestTypes WHERE Code='${code}') BEGIN`,
 `INSERT dbo.RequestTypes(Code,Name,IncludesHr,InitiatorRoles) VALUES('${code}',${q(name)},${flow.includes('HR')?1:0},${q(JSON.stringify(allowed))});`);
 flow.forEach((role,index)=>lines.push(`INSERT dbo.WorkflowSteps(TypeCode,Position,Role) VALUES('${code}',${index+1},${q(role)});`));
 lines.push('END;');
}
lines.push('COMMIT;','GO','-- Reference data only: no demo people, passwords, tickets, or grants.');
await writeFile(new URL('../sql/003-reference-data.sql',import.meta.url),lines.join('\n')+'\n');
console.log('Reference SQL generated. Review before deployment.');
