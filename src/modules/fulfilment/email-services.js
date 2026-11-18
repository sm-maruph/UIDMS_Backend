const resetSystems=['ICBS','RVI Web Portal Access','Query','ITMBD','T4S','Cheque Clearing','BEFTN','HRIS','LOS','WBO','Eximbills','SWIFT_Jump','SWIFT ID','SWIFT Demerged ID (ex-BNGLXXXXX / BD0XXXXXX)','CITRIX_R','AD ID','AMLOCK ID','Internet Access','E-Journal','FX Portal','Quantum','NID Verification','E2gen','MCAS','Jira ID','ITMBD Test','ICBS Test'];
const accessSystems=[...resetSystems,'Email','Wi-Fi Access','External Device Access','IDrive','S Drive','N Drive','MS Office'];

export const emailServices={
 'new-id':{types:['new-id','new-user','self-access'],systems:[...resetSystems,'Email','MS Office','Other software'],variables:['designation','email','requestedEmail','adRole','otherSoftware','similarId','additionalFunction']},
 'employee-deactivation':{types:['employee-deactivate'],systems:[],variables:['designation','email','scope']},
 'system-deactivation':{types:['system-deactivate'],systems:[...accessSystems,'Remmit Plus'],variables:['designation','email','scope']},
 reset:{types:['reset'],systems:resetSystems,variables:['designation','email']},
 upgrade:{types:['upgrade'],systems:accessSystems,variables:['currentRole','similarId','additionalFunction']},
 'email-creation':{types:['email'],systems:[],variables:['requestedEmail','designation']},
 'mailing-group':{types:['mailing-group'],systems:[],variables:['email','groupAction','mailingGroups']},
 'auto-forward':{types:['auto-forward'],systems:[],variables:['email','forwardTo']},
 drive:{types:['idrive'],systems:['IDrive','S Drive'],variables:['driveName']},
 external:{types:['external-device'],systems:[],variables:['email','deviceModel','deviceNumber','serialNumber']},
};

export const categoryForType=type=>Object.keys(emailServices).find(category=>emailServices[category].types.includes(type))||'';
