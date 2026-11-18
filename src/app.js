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
import {dashboardRoutes} from './modules/dashboard/routes.js';
import {adminRoutes} from './modules/admin/routes.js';
import {attachmentRoutes} from './modules/attachments/routes.js';
import {SqlRateLimitStore} from './core/rate-limit-store.js';

export function createApp({db,config}){
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
 app.use(cors({origin:config.origins,credentials:true,methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type','X-CSRF-Token'],exposedHeaders:['X-Request-ID'],maxAge:600}));
 app.use('/api',rateLimit({windowMs:60000,limit:180,store:config.NODE_ENV==='test'?undefined:new SqlRateLimitStore(db,'api'),standardHeaders:'draft-8',legacyHeaders:false,message:{error:{code:'RATE_LIMITED',message:'Too many requests.'}}}));
 app.use('/api/auth',rateLimit({windowMs:15*60000,limit:30,store:config.NODE_ENV==='test'?undefined:new SqlRateLimitStore(db,'auth'),standardHeaders:'draft-8',legacyHeaders:false,message:{error:{code:'AUTH_RATE_LIMITED',message:'Try again later.'}}}));
 app.use(cookieParser());
 app.use((req,res,next)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!req.is('application/json'))return next(new HttpError(415,'JSON_REQUIRED'));next();});
 app.use(express.json({limit:'512kb',strict:true}));
 const auth=createAuth(db,config);
 app.get('/health/live',(req,res)=>res.json({status:'ok'}));
 app.use('/api/auth',authRoutes(db,auth));
 const api=express.Router();api.use(auth.authenticate);
 api.use(directoryRoutes(db));api.use('/requests',requestRoutes(db));api.use('/queries',queryRoutes(db));api.use(fulfilmentRoutes(db,config));api.use(attachmentRoutes(db));api.use(dashboardRoutes(db));api.use('/admin',adminRoutes(db,config));
 app.use('/api',api);
 app.use((req,res,next)=>next(new HttpError(404,'NOT_FOUND')));
 app.use(errorHandler);
 return app;
}
