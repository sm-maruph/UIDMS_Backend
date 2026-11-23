export const canonicalRole=role=>role==='Platform Admin'?'Admin':role;
const readJson=(value,fallback)=>{try{return typeof value==='string'?JSON.parse(value):value||fallback;}catch{return fallback;}};
export function effectiveRoles(user){
 const saved=readJson(user?.EffectiveRolesJson,null);
 return [...new Set((user?.EffectiveRoles||saved?.map(row=>row.Role)||[user?.Role]).filter(Boolean).map(canonicalRole))];
}
export const hasRole=(user,...roles)=>effectiveRoles(user).some(role=>roles.map(canonicalRole).includes(role));
export const isAdministrator=user=>hasRole(user,'Admin','Super Admin');
export const canRecordAccess=user=>hasRole(user,'IT','Admin','Super Admin');
export function hydrateAuthority(user){
 const scopes=readJson(user.ManagedScopesJson,user.ManagedScopes||[]).map(scope=>({...scope,ScopeId:String(scope.ScopeId).toLowerCase()}));
 const roles=[...new Set([...effectiveRoles(user),...scopes.map(scope=>scope.Role)])],base=canonicalRole(user.BaseRole||user.Role);
 const role=['Super Admin','Admin','CITO','IT','COO','HR','Department head','Branch manager','User'].find(role=>roles.includes(role))||'User';
 return {...user,BaseRole:base,Role:role,EffectiveRoles:roles,ManagedScopes:scopes,CanApproveRequests:Boolean(user.CanApproveRequests||scopes.length||roles.some(role=>['IT','HR','CITO','COO','Branch manager','Department head'].includes(role)))};
}
export function canManageAccount(actor,previousRole,nextRole){
 if(hasRole(actor,'Super Admin'))return true;
 if(!hasRole(actor,'Admin'))return false;
 const previous=canonicalRole(previousRole),next=canonicalRole(nextRole);
 if(!['Admin','Super Admin'].includes(next))return true;
 if(!['Admin','Super Admin'].includes(previous))return false;
 return next!=='Super Admin'||previous==='Super Admin';
}
