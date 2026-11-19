import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {BerReader,BerWriter} from 'ldapts';
import {createLdapDirectory} from '../src/modules/auth/ldap-directory.js';

// Real ldapts client and TCP sockets. These tests catch constructor-driven TLS upgrades.
for(const mode of ['plain','starttls','ldaps'])test(`${mode} sends the correct initial protocol bytes`,{timeout:5000},async()=>{
 const sockets=new Set(),observed=[];
 const server=createServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});let buffer=Buffer.alloc(0),answered=false;
  socket.on('data',data=>{
   if(answered)return;buffer=Buffer.concat([buffer,data]);
   if(buffer[0]===0x16){observed.push({firstByte:buffer[0]});answered=true;socket.end();return;}
   if(buffer[0]!==0x30){observed.push({firstByte:buffer[0]});answered=true;socket.destroy();return;}
   try{
    const reader=new BerReader(buffer);reader.readSequence();if(buffer.length<reader.offset+reader.length)return;
    const messageId=reader.readInt(),operation=reader.peek();
    const details={firstByte:buffer[0],operation};
    if(operation===0x60){reader.readSequence(0x60);details.version=reader.readInt();details.account=reader.readString();details.password=reader.readString(0x80);}
    observed.push(details);answered=true;
    // Return a complete LDAP result, avoiding real credentials or certificate fixtures.
    const writer=new BerWriter();writer.startSequence();writer.writeInt(messageId);writer.startSequence(operation===0x77?0x78:0x61);writer.writeEnumeration(operation===0x77?53:49);writer.writeString('');writer.writeString('fixture response');writer.endSequence();writer.endSequence();socket.write(writer.buffer);
   }catch{socket.destroy();}
  });
 });
 let failure;
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const directory=createLdapDirectory({AUTH_MODE:'ad',LDAP_ENABLED:true,LDAP_HOST:'127.0.0.1',LDAP_PORT:server.address().port,LDAP_USERNAME:'fixture@example.test',LDAP_PASSWORD:'fixture-service-password',LDAP_BASE_DN:'dc=example,dc=test',LDAP_TIMEOUT:1000,LDAP_DIRECTORY_ID:'fixture',LDAP_SSL:mode==='ldaps',LDAP_TLS:mode==='starttls'});
  try{await directory.probe();}catch(error){failure=error;}
  assert.ok(failure);assert.equal(observed.length,1);
  if(mode==='ldaps')assert.equal(observed[0].firstByte,0x16,'LDAPS must begin with TLS.');
  else{
   assert.equal(observed[0].firstByte,0x30,'ldap:// must begin with an LDAP message, not a TLS ClientHello.');
   assert.equal(observed[0].operation,mode==='starttls'?0x77:0x60);
   if(mode==='plain'){
    assert.equal(observed[0].version,3);assert.equal(observed[0].account,'fixture@example.test');assert.equal(observed[0].password,'fixture-service-password');
    assert.equal(failure.diagnostic.reason,'service_credentials_rejected');assert.equal(failure.diagnostic.ldapCode,49);
   }
  }
 }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
