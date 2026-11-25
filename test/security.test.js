import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../src/app.js';
import {digest} from '../src/core/crypto.js';
import {testConfig,user,actorId,otherId} from './helpers.js';

const csrf='a'.repeat(43),session='b'.repeat(43);
function setup(handler){
 const calls=[];
 const db={query:async(text,params)=>{calls.push({text,params});if(text.startsWith('UPDATE dbo.Sessions SET LastSeenAt'))return {recordsets:[[{TokenHash:digest(session)}],[{...user,CsrfHash:digest(csrf)}]]};return handler?handler(text,params):{recordset:[],recordsets:[[]]};},transaction:async fn=>fn(db.query)};
 return {app:createApp({db,config:testConfig}),calls};
}
test('health response uses security headers and exposes no implementation signature',async()=>{
 const {app}=setup();const response=await request(app).get('/health/live');assert.equal(response.status,200);assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.headers['x-frame-options'],'SAMEORIGIN');assert.equal(response.headers['x-powered-by'],undefined);assert.equal(response.headers['cache-control'],'no-store');assert.match(response.headers['content-security-policy'],/default-src 'none'/);
});
test('API requires authentication before reading data',async()=>{const {app}=setup();const result=await request(app).get('/api/requests');assert.equal(result.status,401);assert.equal(result.body.error.code,'UNAUTHENTICATED');});

test('an optional signature returns no content when absent and only reads the authenticated profile',async()=>{
 const {app,calls}=setup(()=>({recordset:[{Signature:null}]}));
 const anonymous=await request(app).get('/api/profile/signature');assert.equal(anonymous.status,401);
 assert.equal(calls.some(call=>call.text.startsWith('SELECT Signature')),false);
 const response=await request(app).get('/api/profile/signature').query({id:otherId}).set('Cookie',`uidms_dev=${session}`);
 assert.equal(response.status,204);assert.equal(response.text,'');assert.equal(response.headers['cache-control'],'no-store');
 const query=calls.find(call=>call.text.startsWith('SELECT Signature'));assert.equal(query.params.id.value,actorId);
});

test('a saved signature is returned as PNG while a missing profile remains an error',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
 const saved=setup(()=>({recordset:[{Signature:png}]}));
 const response=await request(saved.app).get('/api/profile/signature').set('Cookie',`uidms_dev=${session}`);
 assert.equal(response.status,200);assert.match(response.headers['content-type'],/^image\/png/);assert.deepEqual(response.body,png);
 const missing=setup(()=>({recordset:[]}));
 const rejected=await request(missing.app).get('/api/profile/signature').set('Cookie',`uidms_dev=${session}`);
 assert.equal(rejected.status,404);assert.equal(rejected.body.error.code,'USER_NOT_FOUND');
});
test('cross-origin writes and writes without Origin are rejected',async()=>{
 const {app}=setup();for(const origin of ['https://attacker.example',null]){let call=request(app).post('/api/auth/login');if(origin)call=call.set('Origin',origin);const result=await call.send({employeeId:'TEST',password:'something'});assert.equal(result.status,403);}
});
test('non-JSON input and malformed JSON are rejected',async()=>{
 const {app}=setup();const text=await request(app).post('/api/auth/login').set('Origin',testConfig.origins[0]).type('form').send('employeeId=x');assert.equal(text.status,415);
 const malformed=await request(app).post('/api/auth/login').set('Origin',testConfig.origins[0]).set('Content-Type','application/json').send('{');assert.equal(malformed.status,400);
});
test('CSRF token required for authenticated writes',async()=>{const {app}=setup();const result=await request(app).post('/api/requests').set('Origin',testConfig.origins[0]).set('Cookie',`uidms_dev=${session}`).send({});assert.equal(result.status,403);assert.equal(result.body.error.code,'CSRF_INVALID');});
test('ordinary users cannot create users or alter workflows',async()=>{
 const {app}=setup();for(const url of ['/api/users','/api/admin/mailing-groups']){const result=await request(app).post(url).set('Origin',testConfig.origins[0]).set('Cookie',`uidms_dev=${session}`).set('X-CSRF-Token',csrf).send({});assert.equal(result.status,403);}
});
test('request creation rejects client-selected status and approver fields',async()=>{
 const {app}=setup();const result=await request(app).post('/api/requests').set('Origin',testConfig.origins[0]).set('Cookie',`uidms_dev=${session}`).set('X-CSRF-Token',csrf).send({typeCode:'reset',status:'Approved',assignedRole:'User',requesterId:otherId});assert.equal(result.status,400);
});
test('SQL injection in search stays in a typed parameter and sort is allowlisted',async()=>{
 const {app,calls}=setup(()=>({recordsets:[[{Total:0}],[]]}));const attack="'; DROP TABLE dbo.Users;--";
 const result=await request(app).get('/api/requests').query({scope:'mine',search:attack}).set('Cookie',`uidms_dev=${session}`);assert.equal(result.status,200);
 const call=calls.find(item=>item.text.includes('OFFSET @offset'));assert.ok(call);assert.equal(call.text.includes(attack),false);assert.equal(call.params.search.value,attack);assert.equal(call.params.actor.value,actorId);assert.match(call.text,/r.RequesterId=@actor/);
 const badSort=await request(app).get('/api/requests').query({sort:'CreatedAt; DROP TABLE Users'}).set('Cookie',`uidms_dev=${session}`);assert.equal(badSort.status,400);
});
test('pagination is bounded',async()=>{const {app}=setup();for(const query of [{pageSize:10000},{page:-1}]){const response=await request(app).get('/api/requests').query(query).set('Cookie',`uidms_dev=${session}`);assert.equal(response.status,400);}});
test('object-level access returns 404 without disclosing an inaccessible ticket',async()=>{const {app}=setup(()=>({recordset:[]}));const response=await request(app).get(`/api/requests/${otherId}`).set('Cookie',`uidms_dev=${session}`);assert.equal(response.status,404);assert.equal(response.body.error.code,'REQUEST_NOT_FOUND');});
test('unexpected database errors do not leak SQL, credentials or stack traces',async()=>{const {app}=setup(()=>{throw new Error('SQL SELECT PasswordHash FROM Users; secret=database-password');});const response=await request(app).get('/api/lookups').set('Cookie',`uidms_dev=${session}`);assert.equal(response.status,500);assert.equal(JSON.stringify(response.body).includes('PasswordHash'),false);assert.equal(JSON.stringify(response.body).includes('database-password'),false);assert.ok(response.body.error.requestId);});

test('initial session discovery is a normal anonymous response while protected APIs still require login',async()=>{const{app,calls}=setup();const response=await request(app).get('/api/auth/session');assert.equal(response.status,200);assert.deepEqual(response.body,{authenticated:false});assert.equal(response.headers['cache-control'],'no-store');assert.equal(calls.length,0);assert.equal((await request(app).get('/api/requests')).status,401);assert.equal((await request(app).post('/api/auth/logout').set('Origin',testConfig.origins[0]).send({})).status,401);});
test('session discovery returns a fresh CSRF token only for a verified cookie session',async()=>{const{app,calls}=setup();const response=await request(app).get('/api/auth/session').set('Cookie',`uidms_dev=${session}`);assert.equal(response.status,200);assert.equal(response.body.authenticated,true);assert.equal(response.body.user.id,actorId);assert.match(response.body.csrfToken,/^[\w-]{43}$/);assert.ok(calls.some(call=>call.text.startsWith('UPDATE dbo.Sessions SET CsrfHash')));assert.equal(response.body.user.PasswordHash,undefined);});
test('expired session discovery is anonymous and database errors remain errors',async()=>{for(const fail of [false,true]){const db={query:async()=>{if(fail)throw Error('Database unavailable');return{recordsets:[[],[]]};}};const app=createApp({db,config:testConfig});const response=await request(app).get('/api/auth/session').set('Cookie',`uidms_dev=${session}`);assert.equal(response.status,fail?500:200);if(!fail)assert.deepEqual(response.body,{authenticated:false});}});

test('background status and data reads do not refresh idle time; explicit continue requires CSRF',async()=>{const{app,calls}=setup();const status=await request(app).get('/api/auth/status').set('Cookie',`uidms_dev=${session}`);assert.equal(status.status,200);assert.ok(status.body.session.expiresAt);assert.equal(calls.find(call=>call.text.startsWith('UPDATE dbo.Sessions SET LastSeenAt')).params.touch.value,false);const denied=await request(app).post('/api/auth/continue').set('Origin',testConfig.origins[0]).set('Cookie',`uidms_dev=${session}`).send({});assert.equal(denied.status,403);const continued=await request(app).post('/api/auth/continue').set('Origin',testConfig.origins[0]).set('Cookie',`uidms_dev=${session}`).set('X-CSRF-Token',csrf).send({});assert.equal(continued.status,200);assert.ok(continued.body.session.idleExpiresAt);assert.ok(calls.some(call=>call.params?.event?.value==='auth.session_continued'));});
