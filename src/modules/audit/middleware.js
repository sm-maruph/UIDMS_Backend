import {HttpError} from '../../core/errors.js';
import {audit} from './service.js';
export const auditFailures=db=>async(error,req,res,next)=>{
 if(req.auditSessionId&&req.user&&!res.headersSent){
  try{await audit(db.query,req,'action.failed',null,{method:req.method,route:typeof req.route?.path==='string'?req.baseUrl+req.route.path:'/api',code:error instanceof HttpError?error.code:'INTERNAL_ERROR',status:error instanceof HttpError?error.status:500});}
  catch(failure){console.error(JSON.stringify({event:'audit.write_failed',requestId:req.id,code:failure.code||failure.name}));}
 }
 next(error);
};
