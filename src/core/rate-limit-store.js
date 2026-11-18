import {p} from './db.js';
import {digest} from './crypto.js';
// Shared SQL-backed counters survive restarts and are consistent across API instances.
export class SqlRateLimitStore {
 constructor(db,namespace){this.db=db;this.namespace=namespace;this.localKeys=false;this.prefix=namespace;}
 init(options){this.windowMs=options.windowMs;}
 async increment(key){
  return this.db.transaction(async query=>{
   const params={namespace:p.str(this.namespace,30),key:p.str(digest(key),64),window:p.int(this.windowMs)};
   await query('UPDATE dbo.RateLimitBuckets WITH(UPDLOCK,HOLDLOCK) SET TotalHits=CASE WHEN ResetAt<=SYSUTCDATETIME() THEN 1 ELSE TotalHits+1 END,ResetAt=CASE WHEN ResetAt<=SYSUTCDATETIME() THEN DATEADD(millisecond,@window,SYSUTCDATETIME()) ELSE ResetAt END WHERE Namespace=@namespace AND KeyHash=@key; IF @@ROWCOUNT=0 INSERT dbo.RateLimitBuckets(Namespace,KeyHash,TotalHits,ResetAt) VALUES(@namespace,@key,1,DATEADD(millisecond,@window,SYSUTCDATETIME()))',params);
   const row=(await query('SELECT TotalHits,ResetAt FROM dbo.RateLimitBuckets WHERE Namespace=@namespace AND KeyHash=@key',params)).recordset[0];
   return {totalHits:row.TotalHits,resetTime:new Date(row.ResetAt)};
  });
 }
 async decrement(key){await this.db.query('UPDATE dbo.RateLimitBuckets SET TotalHits=CASE WHEN TotalHits>0 THEN TotalHits-1 ELSE 0 END WHERE Namespace=@namespace AND KeyHash=@key',{namespace:p.str(this.namespace,30),key:p.str(digest(key),64)});}
 async resetKey(key){await this.db.query('DELETE dbo.RateLimitBuckets WHERE Namespace=@namespace AND KeyHash=@key',{namespace:p.str(this.namespace,30),key:p.str(digest(key),64)});}
}
