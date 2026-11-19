import {SqlRateLimitStore} from './rate-limit-store.js';

const credentialPaths=new Set(['/login','/activate','/mfa/enroll','/mfa/verify','/password','/onboarding/options','/onboarding/complete']);
export function rateLimitResponse(code,message){
 return (req,res,next,options)=>{
  const reset=req.rateLimit?.resetTime?.getTime();
  const seconds=Math.max(1,Math.ceil((reset?reset-Date.now():options.windowMs)/1000));
  res.set('Retry-After',String(seconds));
  res.status(429).json({error:{code,message:`${message} Try again in ${seconds} seconds.`,retryAfterSeconds:seconds,requestId:req.id}});
 };
}

export function authRateLimitOptions(db,config){
 return {
  windowMs:15*60000,limit:30,
  store:config.NODE_ENV==='test'?undefined:new SqlRateLimitStore(db,'auth'),
  standardHeaders:'draft-8',legacyHeaders:false,
  skip:req=>req.method!=='POST'||!credentialPaths.has(req.path.toLowerCase().replace(/\/+$/,'')),
  skipSuccessfulRequests:true,
  // Directory/DB availability failures are not bad-password attempts. The global API cap still applies.
  requestWasSuccessful:(req,res)=>res.statusCode<400||res.statusCode>=500,
  handler:rateLimitResponse('AUTH_RATE_LIMITED','Too many unsuccessful sign-in attempts.'),
 };
}
