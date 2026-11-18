import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {hashPassword,verifyPassword,seal,unseal,token,digest} from '../src/core/crypto.js';
import {readConfig} from '../src/config.js';
import {testConfig} from './helpers.js';
import {validFile} from '../src/modules/attachments/routes.js';

test('scrypt hashes have individual salts and reject wrong passwords and malformed hashes',async()=>{
 const first=await hashPassword('A sufficiently long secret passphrase');const second=await hashPassword('A sufficiently long secret passphrase');assert.notEqual(first,second);assert.match(first,/^scrypt\$131072\$8\$1\$/);
 assert.equal(await verifyPassword('A sufficiently long secret passphrase',first),true);assert.equal(await verifyPassword('wrong password',first),false);assert.equal(await verifyPassword('guess','corrupt-hash'),false);
});
test('AES-GCM binds ciphertext to its intended context and detects tampering',()=>{
 const key=randomBytes(32).toString('base64');const encrypted=seal('sensitive delivery',key,'user:1');assert.equal(unseal(encrypted,key,'user:1'),'sensitive delivery');assert.throws(()=>unseal(encrypted,key,'user:2'));assert.throws(()=>unseal(encrypted.slice(0,-4)+'AAAA',key,'user:1'));assert.equal(encrypted.includes('sensitive delivery'),false);
});
test('opaque tokens use 256-bit entropy and are stored by hash',()=>{assert.match(token(),/^[\w-]{43}$/);assert.notEqual(token(),token());assert.match(digest(token()),/^[a-f0-9]{64}$/);});
test('production refuses insecure configuration',()=>{
 const env={...testConfig,NODE_ENV:'production',ALLOWED_ORIGINS:'https://uidms.example',DB_ENCRYPT:'true',DB_TRUST_CERTIFICATE:'false',COOKIE_SECURE:'true',MFA_REQUIRED:'true'};assert.equal(readConfig(env).NODE_ENV,'production');
 for(const change of [{DB_TRUST_CERTIFICATE:'true'},{COOKIE_SECURE:'false'},{MFA_REQUIRED:'false'},{ALLOWED_ORIGINS:'http://uidms.example'},{TRUST_PROXY:'true'}])assert.throws(()=>readConfig({...env,...change}));
});
test('attachment MIME must match allowed file signatures',()=>{assert.equal(validFile(Buffer.from('<svg onload=alert(1)>'),'image/png'),false);assert.equal(validFile(Buffer.from('%PDF-1.7'),'application/pdf'),true);assert.equal(validFile(Buffer.from('<script>'),'text/html'),false);});
