import {Router} from 'express';
import {p} from '../../core/db.js';
import {z,text,parse,uuidParam} from '../../core/validation.js';
import {requireCondition} from '../../core/errors.js';
import {roles,recentAuth} from '../auth/service.js';
import {audit} from '../audit/service.js';
export const organizationName=value=>value.normalize('NFKC').trim().replace(/\s+/g,' ');
const key=value=>organizationName(value).toLowerCase();
const name=text(150).transform(organizationName).refine(value=>value.length>0&&value.length<=150);
export async function saveOrganization(db,req,id,body){return db.transaction(async query=>{
 const rows=(await query('SELECT Id,Kind,Name,Active,DeletedAt FROM dbo.Lookups WITH(UPDLOCK,HOLDLOCK) WHERE Kind=@kind',{kind:p.str(body.kind,20)})).recordset;
 const existing=id?rows.find(row=>row.Id===id):null;
 if(id){requireCondition(existing&&!existing.DeletedAt,404,'LOOKUP_NOT_FOUND');requireCondition(existing.Name===body.expectedName&&Boolean(existing.Active)===body.expectedActive,409,'STALE_ORGANIZATION','This record changed. Reload it before saving.');}
 requireCondition(!rows.some(row=>row.Id!==id&&key(row.Name)===key(body.name)),409,'DUPLICATE_ORGANIZATION','Another entry already has this name. Edit that entry instead.');
 if(id&&existing.Active&&!body.active){const refs=await organizationReferences(query,id);requireCondition(refs.total===0,409,'ORGANIZATION_IN_USE','This entry is linked to employees, requests or assignments. You can rename it, but cannot deactivate it.');}
 const result=id?await query('UPDATE dbo.Lookups SET Name=@name,Active=@active OUTPUT inserted.Id WHERE Id=@id',{name:p.text(body.name,150),active:p.bit(body.active),id:p.id(id)}):await query('INSERT dbo.Lookups(Kind,Name) OUTPUT inserted.Id VALUES(@kind,@name)',{kind:p.str(body.kind,20),name:p.text(body.name,150)});
 const saved=result.recordset[0];await audit(query,req,id?'lookup.updated':'lookup.created',saved.Id,{kind:body.kind,previousName:existing?.Name||null,name:body.name,active:id?body.active:true});return {id:saved.Id};
});}
export async function organizationReferences(query,id){
 const result=await query(`SELECT (SELECT COUNT(*) FROM dbo.Users WHERE BranchId=@id OR DepartmentId=@id OR DesignationId=@id) AS employees,
 (SELECT COUNT(*) FROM dbo.Requests WHERE BranchId=@id OR DepartmentId=@id OR DestinationBranchId=@id OR DestinationDepartmentId=@id) AS requests,
 (SELECT COUNT(*) FROM dbo.RequestPeople WHERE BranchId=@id OR DepartmentId=@id) AS people,
 (SELECT COUNT(*) FROM dbo.RequestSteps WHERE BranchId=@id OR DepartmentId=@id) AS steps,
 (SELECT COUNT(*) FROM dbo.OrganizationApprovers WHERE ScopeId=@id) AS approvers,
 (SELECT COUNT(*) FROM dbo.RoleDelegations WHERE ScopeId=@id) AS acting`,{id:p.id(id)});
 const counts=result.recordset[0];return {...counts,total:Object.values(counts).reduce((sum,value)=>sum+value,0)};
}
export function organizationRoutes(db){const router=Router();
 router.get('/admin/organizations',roles('Admin','Super Admin'),async(req,res)=>{
 const rows=(await db.query(`SELECT l.Id,l.Kind,l.Name,l.Active,u.Name AS ApproverName,u.EmployeeId AS ApproverEmployeeId FROM dbo.Lookups l LEFT JOIN dbo.OrganizationApprovers a ON a.ScopeId=l.Id LEFT JOIN dbo.Users u ON u.Id=a.UserId WHERE l.DeletedAt IS NULL ORDER BY l.Kind,l.Name`)).recordset;
 res.json({items:rows});
 });
 router.get('/admin/organizations/:id',roles('Admin','Super Admin'),async(req,res)=>{const id=uuidParam(req);const row=(await db.query('SELECT Id,Kind,Name,Active FROM dbo.Lookups WHERE Id=@id AND DeletedAt IS NULL',{id:p.id(id)})).recordset[0];requireCondition(row,404,'LOOKUP_NOT_FOUND');res.json({...row,references:await organizationReferences(db.query,id)});});
 router.post('/lookups',roles('Admin','Super Admin'),recentAuth,async(req,res)=>{const body=parse(z.object({kind:z.enum(['branch','department','designation']),name}).strict(),req.body);res.status(201).json(await saveOrganization(db,req,null,body));});
 router.patch('/lookups/:id',roles('Admin','Super Admin'),recentAuth,async(req,res)=>{const id=uuidParam(req),body=parse(z.object({kind:z.enum(['branch','department','designation']),name,active:z.boolean(),expectedName:text(150),expectedActive:z.boolean()}).strict(),req.body);res.json(await saveOrganization(db,req,id,body));});
 return router;
}
