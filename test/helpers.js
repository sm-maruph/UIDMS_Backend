export const actorId='11111111-1111-4111-8111-111111111111';
export const otherId='22222222-2222-4222-8222-222222222222';
export const branchId='33333333-3333-4333-8333-333333333333';
export const departmentId='44444444-4444-4444-8444-444444444444';
export const requestId='55555555-5555-4555-8555-555555555555';
export const testConfig={NODE_ENV:'test',HOST:'127.0.0.1',PORT:4000,ALLOWED_ORIGINS:'http://localhost:5173',origins:['http://localhost:5173'],TRUST_PROXY:'false',DB_SERVER:'localhost',DB_PORT:1433,DB_NAME:'CBC_UIDMS_Test',DB_USER:'test',DB_PASSWORD:'not-used-in-unit-tests',DB_ENCRYPT:true,DB_TRUST_CERTIFICATE:true,DATA_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_IDLE_MINUTES:15,SESSION_MAX_HOURS:8,COOKIE_SECURE:false,MFA_REQUIRED:true,MAIL_ALLOWED_DOMAINS:'combankbd.com'};
export const user={Id:actorId,EmployeeId:'TEST1',Name:'Test User',Email:'test@combankbd.com',Role:'User',BranchId:branchId,DepartmentId:departmentId,Active:true,Version:Buffer.from('0000000000000001','hex'),AuthenticatedAt:new Date()};
