import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {hasRole} from '../auth/authorization.js';
export const scopedVisibility=`EXISTS(SELECT 1 FROM dbo.uidms_ManagedScopes(@actor) ms JOIN dbo.Lookups ml ON ml.Id=ms.ScopeId WHERE (ml.Kind='branch' AND ms.ScopeId=COALESCE(r.DestinationBranchId,r.BranchId)) OR (ml.Kind='department' AND ms.ScopeId=COALESCE(r.DestinationDepartmentId,r.DepartmentId)))`;
export const reviewAssignment=alias=>`EXISTS(SELECT 1 FROM dbo.uidms_StepReviewers(${alias}.RequestId,${alias}.Position) eligible WHERE eligible.UserId=@actor)`;
export const visibility=`r.DeletedAt IS NULL AND (r.RequesterId=@actor OR r.SubjectUserId=@actor OR EXISTS(SELECT 1 FROM dbo.uidms_EffectiveRoles(@actor) er WHERE er.Role IN ('IT','HR','CITO','COO','Admin','Super Admin','Platform Admin'))
 OR ${scopedVisibility}
 OR EXISTS(SELECT 1 FROM dbo.RequestSteps vs WHERE vs.RequestId=r.Id AND (vs.AssignedUserId=@actor OR vs.ActorId=@actor OR ${reviewAssignment('vs')}))
 OR EXISTS(SELECT 1 FROM dbo.Queries vq WHERE vq.RequestId=r.Id AND (vq.AuthorId=@actor OR vq.RecipientId=@actor))
 OR EXISTS(SELECT 1 FROM dbo.CredentialDeliveries vd WHERE vd.RequestId=r.Id AND vd.RecipientId=@actor))`;
export const actorParams=user=>({actor:p.id(user.Id),actorRole:p.text(user.Role,40),actorBranch:p.id(user.BranchId),actorDepartment:p.id(user.DepartmentId)});
export function canReview(ticket,step,user){return Boolean(step&&(!step.Status||step.Status==='Waiting')&&['Pending','In review'].includes(ticket.Status)&&ticket.RequesterId!==user.Id&&ticket.SubjectUserId!==user.Id&&(Array.isArray(step.EligibleReviewerIds)?step.EligibleReviewerIds.includes(user.Id):step.AssignedUserId?step.AssignedUserId===user.Id:hasRole(user,step.Role)&&(!step.BranchId||step.BranchId===user.BranchId)&&(!step.DepartmentId||step.DepartmentId===user.DepartmentId)));}
export function assertReview(ticket,step,user){requireCondition(canReview(ticket,step,user),403,'NOT_ASSIGNED','This action requires the current assigned approver and separation of duties.');}
export function assertVersion(ticket,version){requireCondition(ticket.Version.toString('hex')===version.toLowerCase(),409,'STALE_VERSION','The ticket changed. Reload it before trying again.');}
export function managerRole(branch,department){
 const norm=value=>String(value||'').toLowerCase().replace(/centre/g,'center').replace(/[^a-z]/g,'');
 return ['headoffice','corporateoffice','digitalbankingandcardcenter'].includes(norm(branch))||(norm(branch)==='gulshanbranch'&&['cardcenter','digitalbanking','callcenter','digitalbankingandcardcenter'].includes(norm(department).replace(/department$/,'')))?'Department head':'Branch manager';
}
export const versionSchema=/^[a-fA-F0-9]{16}$/;
export const workflowRoles=(typeCode,includesHr=false)=>typeCode==='reset'?['CITO']:['Manager',...(includesHr?['HR']:[]),'IT','CITO','COO'];
export function validateJustification(typeCode,value){requireCondition(typeCode==='reset'||String(value||'').trim().length>=10,400,'JUSTIFICATION_REQUIRED','A business justification of at least 10 characters is required for this request type.');}
