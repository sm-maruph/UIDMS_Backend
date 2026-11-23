import {z} from '../../core/validation.js';

export const fixedProcessingCc=['shafi@combankbd.com','hailyalgewatte@combankbd.com'];
export function mergeProcessingCc(existing=[],required=[]){
 return [...new Set([...required,...existing].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim().toLowerCase()))];
}
export function requiredProcessingCc(ticket={}){
 const requester=ticket.RequesterEmail||JSON.parse(ticket.RequesterSnapshot||'{}').email;
 const email=z.email().max(254).safeParse(typeof requester==='string'?requester.trim():requester);
 return mergeProcessingCc(email.success?[email.data]:[],fixedProcessingCc);
}
export function applyProcessingCc(content,ticket){
 const requiredCc=requiredProcessingCc(ticket);
 return {...content,requiredCc,cc:mergeProcessingCc(content.cc,requiredCc)};
}
