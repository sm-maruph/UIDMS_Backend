import {z} from 'zod';
import {HttpError} from './errors.js';
export {z};
// SQL NEWSEQUENTIALID values are GUIDs and need not use RFC UUID version bits.
export const id=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,'Expected a SQL uniqueidentifier').transform(value=>value.toLowerCase());
export const text=(max,min=1)=>z.string().trim().min(min).max(max).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),'Control characters are not allowed');
export const pageSchema=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)});
export function parse(schema,value){const result=schema.safeParse(value);if(!result.success)throw new HttpError(400,'VALIDATION_ERROR',result.error.issues.map(issue=>`${issue.path.join('.')||'body'}: ${issue.message}`).join('; ').slice(0,1200));return result.data;}
export const uuidParam=(req,key='id')=>parse(id,req.params[key]);
const forbidden=new Set(['__proto__','prototype','constructor','password','passwordHash','accessToken','refreshToken','mfaSecret']);
export function safeJson(value,depth=0){
 if(depth>12)return false;
 if(value===null||typeof value==='boolean')return true;
 if(typeof value==='number')return Number.isFinite(value);
 if(typeof value==='string')return value.length<=10000&&!value.includes('\0');
 if(Array.isArray(value))return value.length<=200&&value.every(item=>safeJson(item,depth+1));
 if(typeof value==='object')return Object.keys(value).length<=200&&Object.entries(value).every(([key,item])=>!forbidden.has(key)&&key.length<=150&&safeJson(item,depth+1));
 return false;
}
export const formJson=z.record(z.string(),z.json()).refine(value=>safeJson(value)&&JSON.stringify(value).length<=100000,'Invalid or oversized form data; credentials are not accepted in request details');
