import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import {rateLimit} from 'express-rate-limit';
import {randomUUID} from 'node:crypto';
import {HttpError,errorHandler,requireCondition} from './core/errors.js';
import {createAuth} from './modules/auth/service.js';
import {authRoutes} from './modules/auth/routes.js';
import {directoryRoutes} from './modules/directory/routes.js';
import {requestRoutes} from './modules/requests/routes.js';
import {queryRoutes} from './modules/queries/routes.js';
import {fulfilmentRoutes} from './modules/fulfilment/routes.js';
import {emailTemplateRoutes} from './modules/fulfilment/email-template-routes.js';
import {dashboardRoutes} from './modules/dashboard/routes.js';
import {adminRoutes} from './modules/admin/routes.js';
import {attachmentRoutes} from './modules/attachments/routes.js';
import {SqlRateLimitStore} from './core/rate-limit-store.js';
import {authRateLimitOptions,rateLimitResponse} from './core/auth-rate-limit.js';

export function createApp({db,config,directory}){
 const app=express();app.disable('x-powered-by');app.set('query parser','simple');
 app.set('trust proxy',config.TRUST_PROXY==='false'?false:config.TRUST_PROXY.split(',').map(value=>value.trim()));
 app.use((req,res,next)=>{req.id=randomUUID();res.set('X-Request-ID',req.id);res.set('Cache-Control','no-store');next();});
 app.use(helmet({strictTransportSecurity:config.COOKIE_SECURE?{maxAge:31536000,includeSubDomains:true}:false,contentSecurityPolicy:{directives:{defaultSrc:["'none'"],frameAncestors:["'none'"]}}}));
 app.use((req,res,next)=>{
  if(config.NODE_ENV==='production'&&!req.secure)return next(new HttpError(400,'HTTPS_REQUIRED'));
  const origin=req.get('origin');
  if(origin&&!config.origins.includes(origin))return next(new HttpError(403,'ORIGIN_FORBIDDEN'));
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&(!origin||!config.origins.includes(origin)))return next(new HttpError(403,'ORIGIN_REQUIRED'));
  next();
 });
 app.use(cors({origin:config.origins,credentials:true,methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type','X-CSRF-Token'],exposedHeaders:['X-Request-ID','Retry-After','RateLimit','RateLimit-Policy'],maxAge:600}));
 app.use('/api',rateLimit({windowMs:60000,limit:180,store:config.NODE_ENV==='test'?undefined:new SqlRateLimitStore(db,'api'),standardHeaders:'draft-8',legacyHeaders:false,handler:rateLimitResponse('RATE_LIMITED','Too many requests.')}));
 app.use('/api/auth',rateLimit(authRateLimitOptions(db,config)));
 app.use(cookieParser());
 app.use((req,res,next)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!req.is('application/json'))return next(new HttpError(415,'JSON_REQUIRED'));next();});
 app.use(express.json({limit:'512kb',strict:true}));
 const auth=createAuth(db,config,{directory});
 app.get('/health/live',(req,res)=>res.json({status:'ok'}));
 app.get('/health/db',async(req,res)=>{
  try{
   await db.query('SELECT 1 AS Healthy');
  }catch{
   return res.status(503).json({status:'unavailable',database:'disconnected'});
  }
  return res.json({status:'ok',database:'connected'});
 });
 app.use('/api/auth',authRoutes(db,auth,config));
 const api=express.Router();api.use(auth.authenticate);
 api.use(directoryRoutes(db,config));api.use('/requests',requestRoutes(db));api.use('/queries',queryRoutes(db));api.use(fulfilmentRoutes(db,config));api.use(emailTemplateRoutes(db));api.use(attachmentRoutes(db));api.use(dashboardRoutes(db));api.use('/admin',adminRoutes(db,config));
 app.use('/api',api);
 app.use((req,res,next)=>next(new HttpError(404,'NOT_FOUND')));
 app.use(errorHandler);
 return app;
}
