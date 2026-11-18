import {readConfig} from '../src/config.js';
import {createDatabase} from '../src/core/db.js';
const db=createDatabase(readConfig());
try{await db.connect();await db.query('DELETE dbo.AuthChallenges WHERE ExpiresAt<SYSUTCDATETIME(); DELETE dbo.Sessions WHERE ExpiresAt<DATEADD(day,-1,SYSUTCDATETIME()) OR RevokedAt<DATEADD(day,-1,SYSUTCDATETIME()); UPDATE dbo.CredentialDeliveries SET Ciphertext=NULL WHERE ExpiresAt<SYSUTCDATETIME() AND Ciphertext IS NOT NULL; DELETE dbo.RateLimitBuckets WHERE ResetAt<DATEADD(day,-1,SYSUTCDATETIME())');console.log('Expired challenges, sessions, rate-limit counters, and credential ciphertext cleaned. Audit history retained.');}finally{await db.close();}
