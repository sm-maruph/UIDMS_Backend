import {readConfig} from './config.js';
import {createDatabase} from './core/db.js';
import {createApp} from './app.js';
const config=readConfig();const db=createDatabase(config);
try{
 await db.connect();
 const version=await db.query('SELECT MAX(Version) AS Version FROM dbo.SchemaVersions');
 if(version.recordset[0].Version!==7)throw new Error('Apply SQL migration 010 for directory identity mapping before starting the API.');
 const app=createApp({db,config});
 const server=app.listen(config.PORT,config.HOST,()=>console.log(JSON.stringify({event:'api.started',host:config.HOST,port:config.PORT,environment:config.NODE_ENV})));
 server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxHeadersCount=50;
 let closing=false;
 const stop=()=>{if(closing)return;closing=true;server.close(async()=>{await db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
}catch(error){console.error(JSON.stringify({event:'api.start_failed',code:error.code||error.name,message:error.code?'Check database connectivity, credentials and certificates.':error.message}));await db.close();process.exitCode=1;}
