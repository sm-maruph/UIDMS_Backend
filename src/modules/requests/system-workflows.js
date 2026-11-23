import {p} from '../../core/db.js';
import {requireCondition} from '../../core/errors.js';
import {categoryForType} from '../fulfilment/email-services.js';

// Combine the applicable chains into one ticket-wide sequence while honoring each chain's order.
export function mergeApprovalChains(chains){
 const prerequisites=new Map();
 for(const chain of chains){
  for(const [index,role] of chain.entries()){
   if(!prerequisites.has(role))prerequisites.set(role,new Set());
   if(index)prerequisites.get(role).add(chain[index-1]);
  }
 }
 const merged=[];
 while(prerequisites.size){
  const next=[...prerequisites].find(([,roles])=>roles.size===0);
  requireCondition(next,409,'CONFLICTING_APPROVAL_CHAINS','The selected approval chains specify conflicting stage orders.');
  const [role]=next;
  merged.push(role);
  prerequisites.delete(role);
  for(const roles of prerequisites.values())roles.delete(role);
 }
 return merged;
}

export async function approvalPlan(query,body){
 const type=p.str(body.typeCode,50);
 const baseline=(await query('SELECT Role,Position FROM dbo.WorkflowSteps WHERE TypeCode=@type ORDER BY Position',{type})).recordset;
 requireCondition(baseline.length,409,'WORKFLOW_NOT_CONFIGURED');
 const systemIds=[...new Set(body.items.map(item=>item.systemId))];
 const overrides=(await query(`SELECT CONVERT(uniqueidentifier,selected.value) AS SystemId,approvalRule.TemplateId,approvalRule.Steps
  FROM OPENJSON(@systems) selected CROSS APPLY (
   SELECT TOP (1) o.TemplateId,o.Steps FROM dbo.SystemApprovalOverrides o
   JOIN dbo.SystemEmailTemplates t ON t.Id=o.TemplateId
   LEFT JOIN dbo.SystemEmailTemplateSystems ts ON ts.TemplateId=t.Id AND ts.SystemId=CONVERT(uniqueidentifier,selected.value)
   WHERE o.TypeCode=@type AND (t.Category=@category OR t.Category='') AND (ts.SystemId IS NOT NULL OR t.IsServiceDefault=1)
   ORDER BY CASE WHEN t.Category=@category THEN 0 ELSE 1 END,t.IsServiceDefault,t.Id
  ) approvalRule`,{type,category:p.str(categoryForType(body.typeCode),32),systems:p.json(systemIds)})).recordset;
 if(!overrides.length)return baseline;
 const chains=new Map(overrides.map(row=>[row.TemplateId,JSON.parse(row.Steps)]));
 const defaults=baseline.map(step=>step.Role);
 // Seed the tie order with the baseline while requiring its stages only for unconfigured systems.
 const selected=[...(overrides.length<systemIds.length?[defaults]:[]),...[...chains.values()].sort((a,b)=>a.join().localeCompare(b.join()))];
 return mergeApprovalChains(selected).map((Role,index)=>({Role,Position:index+1}));
}
