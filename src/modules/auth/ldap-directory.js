import {Client,AndFilter,EqualityFilter} from 'ldapts';
import * as net from 'node:net';
import * as tls from 'node:tls';
import {readFile} from 'node:fs/promises';
import {HttpError,requireCondition} from '../../core/errors.js';
import {adLoginEnabled} from './providers.js';

export function directoryAccount(input,config){
 const value=String(input||'').trim();
 requireCondition(value.length>0&&value.length<=160&&!/[\x00-\x20()*=<>~\u007f]/.test(value),401,'INVALID_CREDENTIALS','Invalid directory credentials.');
 if(value.includes('\\')){
  const parts=value.split('\\');
  requireCondition(parts.length===2&&config.LDAP_NETBIOS_DOMAIN&&parts[0].toLowerCase()===config.LDAP_NETBIOS_DOMAIN.toLowerCase(),401,'INVALID_CREDENTIALS','Invalid directory credentials.');
  requireCondition(/^[A-Za-z0-9_.-]{1,64}$/.test(parts[1]),401,'INVALID_CREDENTIALS');
  return {attribute:'sAMAccountName',value:parts[1]};
 }
 if(value.includes('@')){
  const parts=value.split('@');
  requireCondition(parts.length===2&&/^[A-Za-z0-9_.-]{1,64}$/.test(parts[0])&&config.LDAP_UPN_SUFFIX&&parts[1].toLowerCase()===config.LDAP_UPN_SUFFIX.toLowerCase(),401,'INVALID_CREDENTIALS','Use an account in the configured AD domain.');
  return {attribute:'userPrincipalName',value};
 }
 requireCondition(/^[A-Za-z0-9_.-]{1,64}$/.test(value),401,'INVALID_CREDENTIALS');
 return {attribute:'sAMAccountName',value};
}
const attribute=(entry,name)=>{const key=Object.keys(entry).find(key=>key.toLowerCase()===name.toLowerCase());const value=entry[key];return Array.isArray(value)?value[0]:value;};
export function directoryDiagnostic(stage,error){
 let reason='directory_operation_failed';
 if(['EACCES','EPERM'].includes(error?.code))reason='network_access_denied';
 else if(['ENOTFOUND','EAI_AGAIN'].includes(error?.code))reason='dns_lookup_failed';
 else if(error?.code==='ECONNREFUSED')reason='connection_refused';
 else if(error?.code==='ECONNRESET')reason='connection_reset';
 else if(error?.code==='ETIMEDOUT'||/timeout|timed out/i.test(error?.message||''))reason='connection_timeout';
 else if(/CERT|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i.test(String(error?.code||'')))reason='certificate_validation_failed';
 else if(error?.code===49)reason=stage==='service_bind'?'service_credentials_rejected':'user_credentials_rejected';
 else if(error?.code===8||error?.code===13)reason='directory_requires_encryption';
 else if(error?.code==='INVALID_CREDENTIALS')reason=stage==='directory_search'?'account_not_found_or_ambiguous':stage==='account_validation'?'account_disabled_or_invalid':'user_credentials_rejected';
 else if(error?.code==='DIRECTORY_IDENTITY_INVALID')reason='required_identity_attributes_missing';
 else if(error?.code==='DIRECTORY_BASE_NOT_FOUND')reason='base_dn_not_found';
 return {stage,reason,...(Number.isInteger(error?.code)?{ldapCode:error.code}:{})};
}
export function directoryAvailabilityMessage(reason){
 return {
  connection_reset:'The connection to Active Directory was reset before sign-in could be verified. Contact IT.',
  connection_timeout:'The connection to Active Directory timed out. Contact IT to check the directory connection.',
  connection_refused:'Active Directory is not accepting the connection. Contact IT.',
  dns_lookup_failed:'The Active Directory server address could not be resolved. Contact IT.',
  network_access_denied:'The Active Directory connection was blocked on the server. Contact IT.',
  certificate_validation_failed:'The secure connection to Active Directory could not be verified. Contact IT.',
  service_credentials_rejected:'The configured AD service account could not connect. Contact IT.',
  directory_requires_encryption:'Active Directory requires an encrypted connection. Contact IT.',
 }[reason]||'Active Directory is unavailable. Try again later or contact IT.';
}
function identity(entry,config){
 const guid=attribute(entry,'objectGUID'),accountName=attribute(entry,'sAMAccountName'),employeeId=attribute(entry,config.LDAP_EMPLOYEE_ID_ATTRIBUTE)||accountName;
 requireCondition(Buffer.isBuffer(guid)&&guid.length===16&&typeof accountName==='string'&&typeof employeeId==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(employeeId),503,'DIRECTORY_IDENTITY_INVALID','AD did not return a supported immutable identity and employee ID.');
 const control=Number(attribute(entry,'userAccountControl'));
 requireCondition(Number.isSafeInteger(control)&&control>=0&&typeof entry.dn==='string'&&entry.dn.length>0,503,'DIRECTORY_IDENTITY_INVALID','AD did not return the required account attributes.');
 requireCondition(!(control&2),401,'INVALID_CREDENTIALS','Invalid directory credentials.');
 return {systemId:`ad:${config.LDAP_DIRECTORY_ID}:${guid.toString('hex')}`,employeeId:employeeId.toUpperCase(),accountName,upn:attribute(entry,'userPrincipalName')||'',name:attribute(entry,'displayName')||accountName,email:attribute(entry,'mail')||''};
}

export function createLdapDirectory(config,{ClientType=Client}={}){
 async function run(account,password,lookupOnly=false,probeOnly=false){
  requireCondition(adLoginEnabled(config),503,'AD_LOGIN_UNAVAILABLE','Active Directory login is not enabled.');
  const selected=probeOnly?null:directoryAccount(account,config);
  if(!lookupOnly)requireCondition(typeof password==='string'&&password.length>0&&password.length<=128&&!password.includes('\0'),401,'INVALID_CREDENTIALS');
  const clients=[],sockets=new Set();let closed=false,timer,stage='tls_configuration';
  const unavailable=error=>{
   const diagnostic=directoryDiagnostic(stage,error);
   return Object.assign(new HttpError(503,'DIRECTORY_UNAVAILABLE',directoryAvailabilityMessage(diagnostic.reason)),{diagnostic});
  };
  const assertOpen=()=>{if(closed)throw unavailable();};
  const job=async()=>{
   const tlsOptions={host:config.LDAP_HOST,minVersion:'TLSv1.2',rejectUnauthorized:true,...(config.LDAP_TLS_SERVER_NAME?{servername:config.LDAP_TLS_SERVER_NAME}:!net.isIP(config.LDAP_HOST)?{servername:config.LDAP_HOST}:{})};
   if(config.LDAP_CA_FILE)tlsOptions.ca=await readFile(config.LDAP_CA_FILE);
   assertOpen();
   const createClient=async kind=>{
    assertOpen();let rawCreated=false,secureCreated=false;
    const track=socket=>{sockets.add(socket);return socket;};
    // ldapts enables implicit TLS when constructor tlsOptions are present, even for ldap://.
    // Supply them only for LDAPS; StartTLS receives its options explicitly after connecting.
    const client=new ClientType({url:`${config.LDAP_SSL?'ldaps':'ldap'}://${net.isIP(config.LDAP_HOST)===6?'['+config.LDAP_HOST+']':config.LDAP_HOST}:${config.LDAP_PORT}`,timeout:config.LDAP_TIMEOUT,connectTimeout:config.LDAP_TIMEOUT,strictDN:true,autoRebind:false,...(config.LDAP_SSL?{tlsOptions}:{}),
     createConnection:(...args)=>{assertOpen();if(rawCreated)throw unavailable();rawCreated=true;return track(net.connect(...args));},
     createSecureConnection:(...args)=>{assertOpen();if(secureCreated)throw unavailable();secureCreated=true;return track(tls.connect(...args));}});
    clients.push(client);
    stage=kind+'_tls';
    if(config.LDAP_TLS)await client.startTLS({...tlsOptions});
    assertOpen();return client;
   };
   const service=await createClient('service');stage='service_bind';
   await service.bind(config.LDAP_USERNAME,config.LDAP_PASSWORD);assertOpen();
   stage='directory_search';
   if(probeOnly){
    const base=await service.search(config.LDAP_BASE_DN,{scope:'base',filter:'(objectClass=*)',attributes:['objectClass'],sizeLimit:1,timeLimit:Math.max(1,Math.ceil(config.LDAP_TIMEOUT/1000)),paged:false});
    assertOpen();requireCondition(base.searchEntries.length===1,503,'DIRECTORY_BASE_NOT_FOUND','The configured directory search base could not be read.');
    return {directory:'reachable',transport:config.LDAP_SSL?'LDAPS':config.LDAP_TLS?'StartTLS':'plaintext-development'};
   }
   const result=await service.search(config.LDAP_BASE_DN,{scope:'sub',sizeLimit:2,timeLimit:Math.max(1,Math.ceil(config.LDAP_TIMEOUT/1000)),paged:false,
    filter:new AndFilter({filters:[new EqualityFilter({attribute:'objectClass',value:'user'}),new EqualityFilter({attribute:'objectCategory',value:'person'}),new EqualityFilter(selected)]}),
    attributes:[...new Set(['objectGUID','sAMAccountName','userPrincipalName','userAccountControl','displayName','mail',config.LDAP_EMPLOYEE_ID_ATTRIBUTE])],explicitBufferAttributes:['objectGUID']});
   assertOpen();requireCondition(result.searchEntries.length===1,401,'INVALID_CREDENTIALS','Invalid directory credentials.');
   stage='account_validation';
   const entry=result.searchEntries[0],verified=identity(entry,config);
   if(!lookupOnly){
    const client=await createClient('user');stage='user_bind';
    try{await client.bind(entry.dn,password);}catch(error){if(error.code===49)throw Object.assign(new HttpError(401,'INVALID_CREDENTIALS','Invalid directory credentials.'),{diagnostic:directoryDiagnostic(stage,error)});throw error;}
    assertOpen();
   }
   return verified;
  };
  try{
   return await Promise.race([job(),new Promise((resolve,reject)=>{timer=setTimeout(()=>{closed=true;for(const socket of sockets)socket.destroy();reject(unavailable({code:'ETIMEDOUT'}));},config.LDAP_TIMEOUT);})]);
  }catch(error){if(error instanceof HttpError){error.diagnostic??=directoryDiagnostic(stage,error);throw error;}throw unavailable(error);}
  finally{
   closed=true;clearTimeout(timer);
   const cleanup=clients.map(client=>client.unbind().catch(()=>{}));
   for(const socket of sockets)socket.destroy();
   await Promise.allSettled(cleanup);
  }
 }
 return {authenticate:(account,password)=>run(account,password),lookup:account=>run(account,undefined,true),probe:()=>run(undefined,undefined,true,true)};
}
