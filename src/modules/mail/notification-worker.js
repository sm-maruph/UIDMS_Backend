import {p,sql} from '../../core/db.js';
import {uidmsEmail} from './html-template.js';
import {currentRequestTypes} from '../requests/catalog.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function notificationEmail(body,portal){
 const data=JSON.parse(body);
 if(data.format!=='uidms-notification-v1'||!uuid.test(data.requestId)||!uuid.test(data.recipientUserId))throw new Error('MAIL_RECORD_INVALID');
 const operations={grant:'Grant access',revoke:'Remove access',reset:'Unlock / Reset',update:'Update access'};
 const actionType=String(data.actionType||'').split(', ').map(value=>operations[value]||'Review request').join(', ');
 data.requestType=data.typeCode==='new-user'?'New AD request':currentRequestTypes[data.typeCode]||data.requestType;
 const content=uidmsEmail({...data,actionType,heading:'Request notification',requestUrl:new URL('/requests/'+encodeURIComponent(data.reference),portal).href});
 return {...content,subject:`UIDMS ${data.reference}: ${data.requestType}`.replace(/[\r\n\0]/g,' ').slice(0,200),data};
}

// Network calls happen after the request transaction commits. The existing SQL
// lease prevents concurrent workers from claiming the same outbox row.
export async function deliverNotificationBatch(db,config,gmail,{limit=100,log=value=>console.info(JSON.stringify(value))}={}){
 if(!config.GMAIL_NOTIFICATIONS_ENABLED)return 0;
 const status=await gmail.status();
 if(!status.configured||!status.connected||!status.testedAt)throw new Error('GMAIL_LIVE_TEST_REQUIRED');
 let delivered=0;
 for(let count=0;count<limit;count++){
  const result=await db.transaction(query=>query(`WITH nextMail AS(
   SELECT TOP(1) * FROM dbo.EmailOutbox WITH(UPDLOCK,ROWLOCK)
   WHERE SentAt IS NULL AND Attempts<5 AND (ClaimedUntil IS NULL OR ClaimedUntil<SYSUTCDATETIME())
    AND JSON_VALUE(CASE WHEN ISJSON(Body)=1 THEN Body ELSE N'{}' END,'$.format')=N'uidms-notification-v1'
   ORDER BY Id)
   UPDATE nextMail SET ClaimedUntil=DATEADD(minute,5,SYSUTCDATETIME()),Attempts=Attempts+1
   OUTPUT inserted.*,CONVERT(varchar(20),inserted.Id) AS QueueId`));
  const mail=result.recordset[0];if(!mail)break;
  const id=String(mail.QueueId??mail.Id),params={id:{type:sql.BigInt,value:id}};
  let accepted=false;
  try{
   const content=notificationEmail(mail.Body,config.MAIL_PORTAL_URL);
   // Use the recipient's current active profile, not an email supplied in a form.
   const recipient=(await db.query(`SELECT u.Email FROM dbo.Users u JOIN dbo.Requests r ON r.Id=@request
    WHERE u.Id=@user AND u.Active=1 AND u.Email IS NOT NULL AND u.Email<>N'' AND r.DeletedAt IS NULL`,{user:p.id(content.data.recipientUserId),request:p.id(content.data.requestId)})).recordset[0];
   if(!recipient)throw new Error('MAIL_RECIPIENT_UNAVAILABLE');
   const response=await gmail.send({to:[recipient.Email],subject:content.subject,html:content.html,text:content.text,messageId:`<uidms-outbox-${id}@${config.GMAIL_SENDER_EMAIL.split('@')[1]}>`});
   accepted=true;
   await db.query('UPDATE dbo.EmailOutbox SET SentAt=SYSUTCDATETIME(),ClaimedUntil=NULL,LastError=NULL WHERE Id=@id',params);
   delivered++;log({event:'mail.gmail_accepted',outboxId:id,messageId:response.messageId});
  }catch(error){
   const code=accepted?'MAIL_ACCEPTED_STATE_UNSAVED':(['MAIL_RECORD_INVALID','MAIL_RECIPIENT_UNAVAILABLE'].includes(error.message)?error.message:/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'MAIL_DELIVERY_UNKNOWN');
   // Only Google's explicit rate-limit rejection is safe to retry automatically.
   // Unknown network outcomes may already have delivered: hold for manual review.
   const retry=code==='GMAIL_RATE_LIMITED';
   await db.query(`UPDATE dbo.EmailOutbox SET LastError=@error,Attempts=CASE WHEN @retry=1 THEN Attempts ELSE 5 END,
    ClaimedUntil=DATEADD(minute,CASE WHEN Attempts<3 THEN 5 ELSE 30 END,SYSUTCDATETIME()) WHERE Id=@id`,{...params,error:p.str(code,100),retry:p.bit(retry)});
   log({event:'mail.delivery_failed',outboxId:id,code,retry});
  }
 }
 return delivered;
}
