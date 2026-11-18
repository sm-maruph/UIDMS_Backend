import {readConfig} from '../src/config.js';
import {createDatabase} from '../src/core/db.js';
const db=createDatabase(readConfig());
try{await db.connect();const result=await db.query('SELECT DB_NAME() AS DatabaseName,MAX(Version) AS SchemaVersion FROM dbo.SchemaVersions; SELECT COUNT(*) AS RequestTypes FROM dbo.RequestTypes; SELECT COUNT(*) AS Systems FROM dbo.Systems; SELECT IS_MEMBER(\'db_owner\') AS IsDbOwner,IS_SRVROLEMEMBER(\'sysadmin\') AS IsSysadmin; SELECT HAS_PERMS_BY_NAME(\'dbo.AuditEvents\',\'OBJECT\',\'UPDATE\') AS CanUpdateAudit,HAS_PERMS_BY_NAME(\'dbo.AuditEvents\',\'OBJECT\',\'DELETE\') AS CanDeleteAudit');console.log(JSON.stringify(result.recordsets,null,2));if(result.recordsets[3][0].IsDbOwner||result.recordsets[3][0].IsSysadmin||result.recordsets[4][0].CanUpdateAudit||result.recordsets[4][0].CanDeleteAudit)throw new Error('Runtime database account has excessive privileges.');}
finally{await db.close();}
