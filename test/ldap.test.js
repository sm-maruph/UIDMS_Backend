import test from 'node:test';
import assert from 'node:assert/strict';
import {createLdapDirectory,directoryAccount,directoryDiagnostic,directoryAvailabilityMessage} from '../src/modules/auth/ldap-directory.js';
import {readConfig} from '../src/config.js';
import {testConfig} from './helpers.js';

const config={...testConfig,AUTH_MODE:'hybrid',LDAP_ENABLED:true,LDAP_HOST:'ad.example.test',LDAP_PORT:389,LDAP_BASE_DN:'dc=example,dc=test',LDAP_USERNAME:'reader@example.test',LDAP_PASSWORD:'service-test-secret',LDAP_TIMEOUT:1000,LDAP_SSL:false,LDAP_TLS:true,LDAP_DIRECTORY_ID:'test-ad',LDAP_NETBIOS_DOMAIN:'EXAMPLE',LDAP_UPN_SUFFIX:'example.test',LDAP_EMPLOYEE_ID_ATTRIBUTE:'sAMAccountName'};
const entry=()=>({dn:'cn=Test User,dc=example,dc=test',objectGUID:Buffer.alloc(16,8),sAMAccountName:'TEST1',userPrincipalName:'TEST1@example.test',displayName:'Test User',mail:'test@example.test',userAccountControl:'512'});
function fake({searchEntry=entry(),bindError,serviceError,searchError,tlsError,hang=false}={}){
 const events=[],clients=[];
 class FakeClient{
  constructor(options){this.id=clients.length;this.options=options;clients.push(this);}
  async startTLS(options){events.push({action:'tls',id:this.id,options});if(tlsError)throw tlsError;}
  async bind(dn,password){events.push({action:'bind',id:this.id,dn,password});if(hang)return new Promise(()=>{});if(this.id===0&&serviceError)throw serviceError;if(this.id===1&&bindError)throw bindError;}
  async search(dn,options){events.push({action:'search',dn,options});if(searchError)throw searchError;return {searchEntries:searchEntry?[searchEntry]:[],searchReferences:[]};}
  async unbind(){events.push({action:'unbind',id:this.id});}
 }
 return {directory:createLdapDirectory(config,{ClientType:FakeClient}),events,clients,FakeClient};
}

test('AD performs verified StartTLS before separate service and user binds, using typed filters and immutable GUID identity',async()=>{
 const {directory,events,clients}=fake();const result=await directory.authenticate('TEST1','user-test-secret');
 assert.equal(result.systemId,'ad:test-ad:'+Buffer.alloc(16,8).toString('hex'));
 assert.equal(result.employeeId,'TEST1');assert.equal(clients.length,2);
 assert.deepEqual(events.map(event=>event.action),['tls','bind','search','tls','bind','unbind','unbind']);
 assert.equal(events[1].password,config.LDAP_PASSWORD);assert.equal(events[4].password,'user-test-secret');assert.equal(events[4].dn,entry().dn);
 assert.equal(events[2].options.sizeLimit,2);assert.deepEqual(events[2].options.explicitBufferAttributes,['objectGUID']);
 assert.equal(events[2].options.filter.filters[2].attribute,'sAMAccountName');assert.equal(events[2].options.filter.filters[2].value,'TEST1');
 for(const client of clients){assert.equal(client.options.tlsOptions,undefined);assert.equal(client.options.autoRebind,false);assert.equal(client.options.timeout,1000);}
 for(const event of events.filter(event=>event.action==='tls'))assert.equal(event.options.rejectUnauthorized,true);
});

test('LDAP injection, foreign domains and empty passwords are rejected before any connection',async()=>{
 for(const id of ['*)(sAMAccountName=*)','TEST1\0','OTHER\\TEST1','TEST1@foreign.test','cn=admin,dc=example']){
  const {directory,events}=fake();await assert.rejects(directory.authenticate(id,'test-password'),error=>error.status===401);assert.equal(events.length,0);
 }
 assert.deepEqual(directoryAccount('EXAMPLE\\TEST1',config),{attribute:'sAMAccountName',value:'TEST1'});
 assert.deepEqual(directoryAccount('TEST1@example.test',config),{attribute:'userPrincipalName',value:'TEST1@example.test'});
 for(const password of ['', 'bad\0password']){const {directory,events}=fake();await assert.rejects(directory.authenticate('TEST1',password));assert.equal(events.length,0);}
});

test('AD errors are sanitized; certificate or service-bind failure never downgrades or binds a user',async()=>{
 for(const options of [{bindError:Object.assign(new Error('private domain response'),{code:49})},{serviceError:Object.assign(new Error('service-password private domain'),{code:49})},{tlsError:new Error('private certificate path')},{searchError:new Error('private directory diagnostic')}]){
  const {directory,events}=fake(options);await assert.rejects(directory.authenticate('TEST1','user-password'),error=>{
   assert.equal(error.status,options.bindError?401:503);assert.doesNotMatch(error.message,/private|service-password/);return true;
  });
  assert.equal(events.filter(event=>event.action==='unbind').length,options.bindError?2:1);
  if(!options.bindError)assert.equal(events.some(event=>event.action==='bind'&&event.id===1),false);
 }
});

test('missing, disabled and incomplete directory entries do not establish a user bind',async()=>{
 for(const searchEntry of [null,{...entry(),userAccountControl:'514'},{...entry(),objectGUID:'not-binary'},{...entry(),userAccountControl:undefined}]){
  const {directory,clients}=fake({searchEntry});await assert.rejects(directory.authenticate('TEST1','user-password'));assert.equal(clients.length,1);
 }
});

test('directory operations have an overall deadline and dispose their clients',async()=>{
 const {FakeClient,events}=fake({hang:true});const directory=createLdapDirectory({...config,LDAP_TIMEOUT:30},{ClientType:FakeClient});
 await assert.rejects(directory.authenticate('TEST1','user-password'),error=>error.code==='DIRECTORY_UNAVAILABLE');
 assert.ok(events.some(event=>event.action==='unbind'));
});

test('LDAPS uses its TLS transport, and operator lookups never require the user password',async()=>{
 const {FakeClient,clients,events}=fake();const directory=createLdapDirectory({...config,LDAP_SSL:true,LDAP_TLS:false,LDAP_PORT:636},{ClientType:FakeClient});
 await directory.lookup('TEST1');assert.equal(clients.length,1);assert.match(clients[0].options.url,/^ldaps:/);assert.equal(events.some(event=>event.action==='tls'),false);
 assert.equal(clients[0].options.tlsOptions.rejectUnauthorized,true);
 assert.equal(events.filter(event=>event.action==='bind').length,1);
});

test('AD configuration rejects insecure production, malformed addresses and accidental transport conflicts',()=>{
 const env=Object.fromEntries(Object.entries({...testConfig,...config,NODE_ENV:'development'}).map(([key,value])=>[key,typeof value==='boolean'?String(value):value]));
 assert.equal(readConfig(env).AUTH_MODE,'hybrid');
 for(const overrides of [{LDAP_HOST:'192.168.301.7'},{LDAP_HOST:'https://ad.example.test/'},{LDAP_TLS:'true',LDAP_SSL:'true'},{LDAP_TLS:'false',LDAP_SSL:'false',HOST:'0.0.0.0'},{LDAP_PASSWORD:''},{LDAP_ENABLED:'false',AUTH_MODE:'ad'},{NODE_DEBUG:'ldapts'}])assert.throws(()=>readConfig({...env,...overrides}));
 assert.equal(readConfig({...env,LDAP_TLS:'false',LDAP_ALLOW_INSECURE_LOCAL:'true'}).LDAP_TLS,false);
 assert.throws(()=>readConfig({...env,NODE_ENV:'production',LDAP_ALLOW_INSECURE_LOCAL:'true'}));
});

test('the basic LDAP environment is sufficient without enable/domain/namespace override fields',()=>{
 const env=Object.fromEntries(Object.entries(testConfig).map(([key,value])=>[key,typeof value==='boolean'?String(value):value]));
 const basic={...env,NODE_ENV:'development',AUTH_MODE:'hybrid',LDAP_HOST:'dc01.example.test',LDAP_PORT:'389',LDAP_BASE_DN:'DC=EXAMPLE,DC=TEST',LDAP_USERNAME:'reader@example.test',LDAP_PASSWORD:'test-service-secret',LDAP_TIMEOUT:'30000',LDAP_SSL:'false',LDAP_TLS:'false'};
 const c=readConfig(basic);assert.equal(c.LDAP_ENABLED,true);assert.equal(c.LDAP_TLS,false);assert.equal(c.LDAP_UPN_SUFFIX,'example.test');assert.equal(c.LDAP_NETBIOS_DOMAIN,'EXAMPLE');assert.equal(c.LDAP_DIRECTORY_ID,'primary-ad');
 assert.throws(()=>readConfig({...basic,NODE_ENV:'production'}),/LDAP simple bind requires/);
 assert.equal(readConfig({...basic,LDAP_ENABLED:'false'}).LDAP_ENABLED,false);
 const ldaps={...basic,LDAP_SSL:'true'};delete ldaps.LDAP_TLS;delete ldaps.LDAP_PORT;
 assert.equal(readConfig(ldaps).LDAP_PORT,636);assert.equal(readConfig(ldaps).LDAP_TLS,false);
});

test('connection diagnostics classify stages without exposing directory or password strings',()=>{
 for(const [stage,error,reason] of [
  ['service_bind',Object.assign(new Error('private hostname service password'),{code:49}),'service_credentials_rejected'],
  ['user_bind',Object.assign(new Error('private user DN password'),{code:49}),'user_credentials_rejected'],
  ['service_bind',new Error('Connection timeout to private host'),'connection_timeout'],
  ['service_tls',{code:'SELF_SIGNED_CERT_IN_CHAIN'},'certificate_validation_failed'],
  ['service_bind',{code:'EACCES'},'network_access_denied'],
 ]){const diagnostic=directoryDiagnostic(stage,error);assert.equal(diagnostic.reason,reason);assert.equal(diagnostic.stage,stage);assert.doesNotMatch(JSON.stringify(diagnostic),/private|hostname|password/);}
});

test('connection probe checks service bind and base DN without needing an employee account',async()=>{
 const {directory,events,clients}=fake();const result=await directory.probe();
 assert.equal(result.directory,'reachable');assert.equal(clients.length,1);
 const search=events.find(event=>event.action==='search');assert.equal(search.options.scope,'base');
 assert.equal(events.filter(event=>event.action==='bind').length,1);
});

test('explicit local plain LDAP does not issue a StartTLS upgrade',async()=>{
 const {FakeClient,events}=fake();const directory=createLdapDirectory({...config,LDAP_TLS:false,LDAP_SSL:false},{ClientType:FakeClient});await directory.probe();
 assert.equal(events.some(event=>event.action==='tls'),false);
});

test('directory connection resets produce an actionable safe message instead of implying a bad employee password',async()=>{
 const {directory}=fake({serviceError:Object.assign(new Error('private host and service credentials'),{code:'ECONNRESET'})});
 await assert.rejects(directory.authenticate('TEST1','user-password'),error=>{
  assert.equal(error.status,503);assert.equal(error.diagnostic.reason,'connection_reset');assert.equal(error.diagnostic.stage,'service_bind');
  assert.match(error.message,/connection.*reset/i);assert.doesNotMatch(error.message,/private|user-password|service credentials/);return true;
 });
 assert.match(directoryAvailabilityMessage('connection_timeout'),/timed out/);
 assert.match(directoryAvailabilityMessage('directory_requires_encryption'),/encrypted/);
});
