import {Router} from 'express';
import {p,sql} from '../../core/db.js';
import {parse,pageSchema,z} from '../../core/validation.js';

const cursor=z.string().refine(value=>/^\d{1,19}$/.test(value)&&BigInt(value)<=9223372036854775807n,'Invalid notification cursor');
// A rolling calendar month, calculated in SQL UTC. Archived records are never deleted.
const visible=`n.UserId=@user AND (n.RequestId IS NULL OR EXISTS(SELECT 1 FROM dbo.Requests r WHERE r.Id=n.RequestId AND r.DeletedAt IS NULL))`;
const recent='n.CreatedAt>=DATEADD(month,-1,@now)';
const summary=`SELECT COUNT(CASE WHEN ${recent} AND n.ReadAt IS NULL THEN 1 END) AS unread, COUNT(CASE WHEN NOT (${recent}) THEN 1 END) AS archivedTotal FROM dbo.Notifications n WHERE ${visible}`;
const columns='CONVERT(varchar(20),n.Id) AS Id,n.RequestId,n.Message,n.CreatedAt,n.ReadAt';

export function notificationRoutes(db){
 const router=Router();
 router.get('/notifications',async(req,res)=>{
  const filter=parse(pageSchema.extend({scope:z.enum(['recent','archived']).default('recent')}).strict(),req.query);
  const where=`${visible} AND ${filter.scope==='recent'?recent:`NOT (${recent})`}`;
  const result=await db.query(`DECLARE @now datetime2(3)=SYSUTCDATETIME(); SELECT COUNT(*) AS Total FROM dbo.Notifications n WHERE ${where}; SELECT ${columns} FROM dbo.Notifications n WHERE ${where} ORDER BY n.CreatedAt DESC,n.Id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY; ${summary}`,{user:p.id(req.user.Id),offset:p.int((filter.page-1)*filter.pageSize),size:p.int(filter.pageSize)});
  res.json({items:result.recordsets[1],total:result.recordsets[0][0].Total,...filter,...result.recordsets[2][0]});
 });
 // Independent ascending cursor prevents missing alerts when multiple pages arrive between polls.
 // No cursor initializes silently, so logging in never sends a flood of old desktop alerts.
 router.get('/notifications/feed',async(req,res)=>{
  const {after}=parse(z.object({after:cursor.optional()}).strict(),req.query);
  const result=await db.query(`DECLARE @now datetime2(3)=SYSUTCDATETIME(); SELECT TOP(100) ${columns} FROM dbo.Notifications n WHERE ${visible} AND ${recent} AND @after IS NOT NULL AND n.Id>@after ORDER BY n.Id; SELECT CONVERT(varchar(20),COALESCE(MAX(n.Id),0)) AS latestId FROM dbo.Notifications n WHERE ${visible}; ${summary}`,{user:p.id(req.user.Id),after:{type:sql.BigInt,value:after??null}});
  const items=result.recordsets[0];
  res.json({items,cursor:items.length?items.at(-1).Id:after??result.recordsets[1][0].latestId,hasMore:items.length===100,...result.recordsets[2][0]});
 });
 router.post('/notifications/:id/read',async(req,res)=>{
  const notification=parse(cursor,req.params.id);
  await db.query('UPDATE dbo.Notifications SET ReadAt=COALESCE(ReadAt,SYSUTCDATETIME()) WHERE Id=@id AND UserId=@user',{id:{type:sql.BigInt,value:notification},user:p.id(req.user.Id)});
  res.status(204).end();
 });
 return router;
}
