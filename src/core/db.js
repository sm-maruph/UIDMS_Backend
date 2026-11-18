import sql from 'mssql';
export {sql};
export function createDatabase(config){
 const pool=new sql.ConnectionPool({server:config.DB_SERVER,port:config.DB_PORT,database:config.DB_NAME,user:config.DB_USER,password:config.DB_PASSWORD,
  options:{encrypt:config.DB_ENCRYPT,trustServerCertificate:config.DB_TRUST_CERTIFICATE,enableArithAbort:true,abortTransactionOnError:true},
  pool:{max:10,min:0,idleTimeoutMillis:30000},connectionTimeout:15000,requestTimeout:15000});
 pool.on('error',error=>console.error(JSON.stringify({event:'database_pool_error',code:error.code})));
 async function query(text,params={},connection=pool){
  const request=new sql.Request(connection);
  for(const [name,param] of Object.entries(params))request.input(name,param.type,param.value??null);
  const result=await request.query(text);
  for(const rows of result.recordsets||[])for(const row of rows)for(const [key,value] of Object.entries(row))if(typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))row[key]=value.toLowerCase();
  return result;
 }
 async function transaction(work){
  const tx=new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try{const result=await work((text,params={})=>query(text,params,tx));await tx.commit();return result;}
  catch(error){try{await tx.rollback();}catch{}throw error;}
 }
 return {query,transaction,connect:()=>pool.connect(),close:()=>pool.close()};
}
export const p={id:value=>({type:sql.UniqueIdentifier,value}),text:(value,size=4000)=>({type:sql.NVarChar(size),value}),long:value=>({type:sql.NVarChar(sql.MAX),value}),str:(value,size=100)=>({type:sql.VarChar(size),value}),int:value=>({type:sql.Int,value}),bit:value=>({type:sql.Bit,value}),date:value=>({type:sql.DateTime2(3),value}),json:value=>({type:sql.NVarChar(sql.MAX),value:JSON.stringify(value)}),bytes:value=>({type:sql.VarBinary(sql.MAX),value})};
