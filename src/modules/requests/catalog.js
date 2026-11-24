// Services actually submitted by the current portal forms. Legacy records remain readable.
export const currentRequestTypes={
 'self-access':'New ID creation (self request)',
 'new-user':'New ID creation (on behalf)',
 'employee-deactivate':'Employee ID deactivation',
 'system-deactivate':'System ID deactivation',
 reset:'Unlock / Reset',upgrade:'ID Role Upgrade',
 movement:'Branch / Department Transfer',email:'Email creation',
 'mailing-group':'Mailing group inclusion/exclusion','auto-forward':'Auto-forward change',
 idrive:'I Drive / S Drive Access','n-drive':'N Drive Access','external-device':'External device email access',
};
export const isCurrentRequestType=code=>Object.hasOwn(currentRequestTypes,code);
export const retiredRequestType=code=>['new-id','branch-transfer','batch-access'].includes(code);
export const portalRequestTypes=rows=>rows.filter(row=>isCurrentRequestType(row.Code)).map(row=>({...row,Name:currentRequestTypes[row.Code]}));
