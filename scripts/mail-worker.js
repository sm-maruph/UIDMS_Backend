import nodemailer from 'nodemailer';
import {readConfig} from '../src/config.js';
import {createDatabase,p,sql} from '../src/core/db.js';
import {createGmail} from '../src/modules/mail/gmail.js';
import {deliverNotificationBatch} from '../src/modules/mail/notification-worker.js';
import {setTimeout as delay} from 'node:timers/promises';
const config=readConfig();
if(!config.GMAIL_NOTIFICATIONS_ENABLED&&!config.SMTP_HOST)throw new Error('Enable Gmail notifications after the live connection test, or configure SMTP.');
const db=createDatabase(config);
const transport=config.GMAIL_NOTIFICATIONS_ENABLED?null:nodemailer.createTransport({host:config.SMTP_HOST,port:config.SMTP_PORT,secure:config.SMTP_SECURE,requireTLS:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:config.SMTP_USER?{user:config.SMTP_USER,pass:config.SMTP_PASSWORD}:undefined,disableFileAccess:true,disableUrlAccess:true,connectionTimeout:15000,socketTimeout:30000});
let stopping=false;const abort=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;abort.abort();});
try{
 await db.connect();
 if(config.GMAIL_NOTIFICATIONS_ENABLED){
  const gmail=createGmail(config);
  console.info(JSON.stringify({event:'mail.worker_started',provider:'gmail',continuous:process.argv.includes('--continuous')}));
  do{
   try{await deliverNotificationBatch(db,config,gmail);}
   catch(error){console.error(JSON.stringify({event:'mail.worker_failed',code:error.message==='GMAIL_LIVE_TEST_REQUIRED'?error.message:'MAIL_WORKER_FAILED'}));if(!process.argv.includes('--continuous'))process.exitCode=1;}
   if(stopping||!process.argv.includes('--continuous'))break;
   try{await delay(15000,undefined,{signal:abort.signal});}catch{break;}
  }while(!stopping);
 }else{
 // Lease one message at a time. Delivery is at least once after crashes; Message-ID aids deduplication.
 for(let count=0;count<100;count++){
  const result=await db.transaction(query=>query("WITH nextMail AS(SELECT TOP(1) * FROM dbo.EmailOutbox WITH(UPDLOCK,ROWLOCK) WHERE SentAt IS NULL AND Attempts<5 AND ISJSON(Body)=0 AND (ClaimedUntil IS NULL OR ClaimedUntil<SYSUTCDATETIME()) ORDER BY Id) UPDATE nextMail SET ClaimedUntil=DATEADD(minute,5,SYSUTCDATETIME()),Attempts=Attempts+1 OUTPUT inserted.*"));
  const mail=result.recordset[0];if(!mail)break;
  try{
   if(!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(mail.Recipient)||!config.MAIL_ALLOWED_DOMAINS.split(',').includes(mail.Recipient.split('@')[1].toLowerCase()))throw new Error('DOMAIN_NOT_ALLOWED');
   await transport.sendMail({from:config.MAIL_FROM,to:mail.Recipient,subject:mail.Subject.replace(/[\r\n]/g,' '),text:mail.Body,messageId:`uidms-outbox-${mail.Id}@${config.MAIL_FROM.split('@')[1]}`});
   await db.query('UPDATE dbo.EmailOutbox SET SentAt=SYSUTCDATETIME(),ClaimedUntil=NULL,LastError=NULL WHERE Id=@id',{id:{type:sql.BigInt,value:mail.Id}});
  }catch{await db.query("UPDATE dbo.EmailOutbox SET LastError='DELIVERY_FAILED' WHERE Id=@id",{id:{type:sql.BigInt,value:mail.Id}});console.error(JSON.stringify({event:'mail.delivery_failed',id:mail.Id}));}
 }
 }
}finally{transport?.close();await db.close();}
