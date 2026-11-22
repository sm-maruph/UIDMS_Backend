import {isIP} from 'node:net';
import {HttpError} from './errors.js';

// IIS can append a source port to X-Forwarded-For. Parse only unambiguous forms;
// a bare IPv6 address ending in digits is still an address, not an IP:port pair.
export function normalizeClientAddress(value){
 if(typeof value!=='string')return null;
 if(isIP(value))return value;
 const ipv4=value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
 const ipv6=value.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
 const match=ipv4||ipv6;
 if(!match||isIP(match[1])!==(ipv4?4:6))return null;
 if(match[2]!==undefined&&(Number(match[2])<1||Number(match[2])>65535))return null;
 return match[1];
}

export function clientAddress(req,res,next){
 // Express applies TRUST_PROXY before this getter is read. Never select an IP
 // directly from a caller-controlled forwarding header here.
 const address=normalizeClientAddress(req.ip);
 if(!address)return next(new HttpError(400,'INVALID_CLIENT_IP','The proxy supplied an invalid client address. Contact IT.'));
 if(address!==req.ip)Object.defineProperty(req,'ip',{value:address,configurable:true});
 next();
}
