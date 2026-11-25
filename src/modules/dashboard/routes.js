import {Router} from 'express';
import {p} from '../../core/db.js';
import {parse,pageSchema,uuidParam,z,text} from '../../core/validation.js';
import {actorParams,visibility} from '../requests/policy.js';

export function dashboardRoutes(db){
 const router=Router();
 router.get('/dashboard',async(req,res)=>{
  const result=await db.query(`WITH visible AS(SELECT r.*,s.Role AS AssignedRole,s.AssignedUserId,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.uidms_StepReviewers(s.RequestId,s.Position) eligible WHERE eligible.UserId=@actor) THEN 1 ELSE 0 END AS bit) AS ReviewableByMe,s.BranchId AS StepBranch,s.DepartmentId AS StepDepartment FROM dbo.Requests r LEFT JOIN dbo.RequestSteps s ON s.RequestId=r.Id AND s.Position=r.CurrentPosition WHERE ${visibility}) SELECT
   COUNT(*) AS total,
   COALESCE(SUM(CASE WHEN Status NOT IN ('Completed','Rejected','Cancelled') THEN 1 ELSE 0 END),0) AS active,
   COALESCE(SUM(CASE WHEN Status IN ('Approved','IT processing','HO processing','Completed') THEN 1 ELSE 0 END),0) AS approved,
   COALESCE(SUM(CASE WHEN Status='Completed' THEN 1 ELSE 0 END),0) AS completed,
   COALESCE(SUM(CASE WHEN Status='Rejected' THEN 1 ELSE 0 END),0) AS rejected,
   COALESCE(SUM(CASE WHEN Status IN ('Pending','In review') AND RequesterId<>@actor AND (SubjectUserId IS NULL OR SubjectUserId<>@actor) AND ReviewableByMe=1 THEN 1 ELSE 0 END),0) AS pendingForMyApproval,
   COALESCE(SUM(CASE WHEN Status IN ('Pending','In review') AND AssignedRole='IT' THEN 1 ELSE 0 END),0) AS pendingAtIt,
   COALESCE(SUM(CASE WHEN Status IN ('Pending','In review') AND AssignedRole='HR' THEN 1 ELSE 0 END),0) AS pendingAtHr,
   COALESCE(SUM(CASE WHEN Status IN ('Pending','In review') AND AssignedRole='CITO' THEN 1 ELSE 0 END),0) AS pendingAtCito,
   COALESCE(SUM(CASE WHEN Status IN ('Pending','In review') AND AssignedRole='COO' THEN 1 ELSE 0 END),0) AS pendingAtCoo,
   COALESCE(SUM(CASE WHEN Status IN ('Approved','IT processing') THEN 1 ELSE 0 END),0) AS itProcessing,
   COALESCE(SUM(CASE WHEN Status='HO processing' THEN 1 ELSE 0 END),0) AS hoProcessing FROM visible;
   SELECT COUNT(DISTINCT q.RequestId) AS query FROM dbo.Queries q JOIN dbo.Requests r ON r.Id=q.RequestId WHERE q.RecipientId=@actor AND r.DeletedAt IS NULL;
   SELECT COUNT(DISTINCT q.RequestId) AS response FROM dbo.Queries q JOIN dbo.Requests r ON r.Id=q.RequestId WHERE q.AuthorId=@actor AND r.DeletedAt IS NULL`,actorParams(req.user));
  res.json({...result.recordsets[0][0],...result.recordsets[1][0],...result.recordsets[2][0]});
 });
 router.get('/notifications',async(req,res)=>{
  const page=parse(pageSchema.strict(),req.query);const result=await db.query('SELECT COUNT(*) AS Total FROM dbo.Notifications WHERE UserId=@user AND (RequestId IS NULL OR EXISTS(SELECT 1 FROM dbo.Requests r WHERE r.Id=RequestId AND r.DeletedAt IS NULL)); SELECT Id,RequestId,Message,CreatedAt,ReadAt FROM dbo.Notifications WHERE UserId=@user AND (RequestId IS NULL OR EXISTS(SELECT 1 FROM dbo.Requests r WHERE r.Id=RequestId AND r.DeletedAt IS NULL)) ORDER BY CreatedAt DESC,Id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY',{user:p.id(req.user.Id),offset:p.int((page.page-1)*page.pageSize),size:p.int(page.pageSize)});res.json({items:result.recordsets[1],total:result.recordsets[0][0].Total,...page});
 });
 router.post('/notifications/:id/read',async(req,res)=>{
  const notification=parse(z.string().regex(/^\d{1,18}$/),req.params.id);
  await db.query('UPDATE dbo.Notifications SET ReadAt=COALESCE(ReadAt,SYSUTCDATETIME()) WHERE Id=@id AND UserId=@user',{id:{type:(await import('../../core/db.js')).sql.BigInt,value:notification},user:p.id(req.user.Id)});res.status(204).end();
 });
 return router;
}
