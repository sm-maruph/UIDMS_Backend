import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,text,parse,uuidParam} from '../../core/validation.js';
import {digest} from '../../core/crypto.js';
import {requireCondition} from '../../core/errors.js';
import {loadTicket} from '../requests/repository.js';
import {audit} from '../audit/service.js';

export function validFile(bytes,type){
 if(type==='image/png')return bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(12,16).toString('ascii')==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(16)<=4096&&bytes.readUInt32BE(20)>0&&bytes.readUInt32BE(20)<=4096;
 if(type==='image/jpeg')return bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(type==='application/pdf')return bytes.subarray(0,5).toString('ascii')==='%PDF-';
 return false;
}
export function attachmentRoutes(db){
 const router=Router();
 router.post('/requests/:id/attachments',async(req,res)=>{
  const requestId=uuidParam(req),body=parse(z.object({name:text(150).refine(value=>!/[\\/\r\n]/.test(value),'Use a file name without a path'),contentType:z.enum(['image/png','image/jpeg','application/pdf']),base64:z.string().min(4).max(349528).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict(),req.body);
  const bytes=Buffer.from(body.base64,'base64');requireCondition(bytes.length<=262144&&validFile(bytes,body.contentType),400,'INVALID_ATTACHMENT');
  const created=await db.transaction(async query=>{
   const ticket=await loadTicket(query,requestId,req.user,{lock:true});requireCondition(ticket.RequesterId===req.user.Id&&ticket.Status==='Pending',403,'ATTACHMENT_NOT_ALLOWED');
   requireCondition((await query('SELECT COUNT(*) AS Count FROM dbo.Attachments WHERE RequestId=@id',{id:p.id(requestId)})).recordset[0].Count<10,409,'ATTACHMENT_LIMIT');
   const row=(await query('INSERT dbo.Attachments(RequestId,UploadedBy,OriginalName,ContentType,Bytes,Sha256) OUTPUT inserted.Id VALUES(@request,@actor,@name,@type,@bytes,@hash)',{request:p.id(requestId),actor:p.id(req.user.Id),name:p.text(body.name,150),type:p.str(body.contentType,50),bytes:p.bytes(bytes),hash:p.str(digest(bytes),64)})).recordset[0];
   await audit(query,req,'attachment.quarantined',row.Id,{requestId,sha256:digest(bytes),bytes:bytes.length});return row;
  });res.status(201).json({id:created.Id,scanStatus:'Quarantined'});
 });
 router.get('/attachments/:id',async(req,res)=>{
  const attachmentId=uuidParam(req);const file=(await db.query('SELECT * FROM dbo.Attachments WHERE Id=@id',{id:p.id(attachmentId)})).recordset[0];requireCondition(file,404,'ATTACHMENT_NOT_FOUND');
  await loadTicket(db.query,file.RequestId,req.user);requireCondition(file.ScanStatus==='Clean',409,'ATTACHMENT_NOT_CLEARED');
  await audit(db.query,req,'attachment.downloaded',attachmentId);
  res.set('Content-Type',file.ContentType);res.set('Content-Security-Policy',"default-src 'none'; sandbox");res.attachment(`document-${attachmentId}.${{'image/png':'png','image/jpeg':'jpg','application/pdf':'pdf'}[file.ContentType]}`);res.send(file.Bytes);
 });
 return router;
}
