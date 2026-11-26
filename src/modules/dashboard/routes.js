import {notificationRoutes} from '../notifications/routes.js';
import {Router} from 'express';
import {p} from '../../core/db.js';
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
 router.use(notificationRoutes(db));
 return router;
}
