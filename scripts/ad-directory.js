import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readConfig} from '../src/config.js';
import {createDatabase} from '../src/core/db.js';
import {createLdapDirectory} from '../src/modules/auth/ldap-directory.js';
import {linkDirectoryIdentity} from '../src/modules/auth/directory-link.js';

let db;
try{
 const {values}=parseArgs({options:{account:{type:'string'},employee:{type:'string'},link:{type:'boolean'},'convert-mock':{type:'boolean'},'replace-link':{type:'boolean'}}});
 if(values.link&&!values.account)throw new Error('Linking requires --account AD_ACCOUNT --employee UIDMS_ID.');
 const config=readConfig(),directory=createLdapDirectory(config);
 if(!values.account){console.log(JSON.stringify(await directory.probe()));process.exit(0);}
 const identity=await directory.lookup(values.account);
 if(!values.link)console.log(JSON.stringify({directory:'reachable',accountFound:true,employeeId:identity.employeeId,accountName:identity.accountName,systemId:identity.systemId,transport:config.LDAP_SSL?'LDAPS':config.LDAP_TLS?'StartTLS':'plaintext-development'}));
 else{
  if(!values.employee||!/^[A-Za-z0-9_-]{1,40}$/.test(values.employee))throw new Error('Specify a valid --employee UIDMS_ID.');
  db=createDatabase(config);await db.connect();
  const result=await linkDirectoryIdentity(db,identity,values.employee,{id:randomUUID(),ip:'directory-admin-cli'},{convertMock:values['convert-mock'],replaceLink:values['replace-link']});
  console.log(JSON.stringify({linked:true,...result}));
 }
}catch(error){
 console.error(JSON.stringify({event:'directory.command_failed',code:error.code||'CONFIGURATION_ERROR',...error.diagnostic,message:error.status?error.message:error.code?'Check directory/database connectivity and configuration.':error.message}));process.exitCode=1;
}finally{if(db)await db.close();}
