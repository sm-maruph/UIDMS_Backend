export class HttpError extends Error {
 constructor(status,code,message=code){super(message);this.status=status;this.code=code;}
}
export const requireCondition=(condition,status,code,message)=>{if(!condition)throw new HttpError(status,code,message);};
export function errorHandler(error,req,res,next){
 if(res.headersSent)return next(error);
 const known=error instanceof HttpError;
 const status=known?error.status:error.type==='entity.too.large'?413:error.type==='entity.parse.failed'?400:error.code==='EREQUEST'&&[2601,2627].includes(error.number)?409:500;
 if(status>=500)console.error(JSON.stringify({event:'request_failed',requestId:req.id,code:error.code||error.name}));
 res.status(status).json({error:{code:known?error.code:status===400?'INVALID_JSON':status===413?'PAYLOAD_TOO_LARGE':status===409?'CONFLICT':'INTERNAL_ERROR',message:known?error.message:'The request could not be completed.',requestId:req.id}});
}
