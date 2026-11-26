import {createHash} from 'node:crypto';
export const sessionCsrf=raw=>createHash('sha256').update('uidms:csrf:'+raw).digest('base64url');
export const sessionLifetimeMinutes=config=>config.SESSION_MAX_MINUTES??(config.SESSION_MAX_HOURS?config.SESSION_MAX_HOURS*60:30);
export const sessionHardLimitHours=config=>config.SESSION_MAX_HOURS??8;
export function sessionWindow(user,config,now=new Date()){
 const started=new Date(user.AuthenticatedAt||user.StartedAt||now);
 const lastSeen=new Date(user.SessionLastSeenAt||user.LastSeenAt||now);
 const policyExpiry=started.getTime()+sessionHardLimitHours(config)*3600000;
 const absolute=new Date(Math.min(+new Date(user.SessionExpiresAt||user.ExpiresAt||policyExpiry),policyExpiry));
 const idle=new Date(lastSeen.getTime()+config.SESSION_IDLE_MINUTES*60000);
 return {serverNow:now.toISOString(),idleExpiresAt:idle.toISOString(),absoluteExpiresAt:absolute.toISOString(),hardExpiresAt:new Date(policyExpiry).toISOString(),expiresAt:new Date(Math.min(+idle,+absolute)).toISOString(),idleTimeoutSeconds:config.SESSION_IDLE_MINUTES*60,warningSeconds:60};
}
