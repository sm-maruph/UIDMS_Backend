import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
export const token=()=>randomBytes(32).toString('base64url');
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function hashPassword(password){const salt=randomBytes(16).toString('hex');const key=await scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024});return `scrypt$131072$8$1$${salt}$${key.toString('hex')}`;}
export async function verifyPassword(password,hash){
 const parts=hash?.split('$');
 const valid=parts?.length===6&&parts[0]==='scrypt'&&parts[1]==='131072'&&parts[2]==='8'&&parts[3]==='1'&&/^[a-f0-9]{32}$/.test(parts[4])&&/^[a-f0-9]{128}$/.test(parts[5]);
 const salt=valid?parts[4]:'00000000000000000000000000000000';
 const key=await scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024});
 return Boolean(valid)&&equal(key.toString('hex'),parts[5]);
}
export function seal(value,key,context){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'base64'),iv);cipher.setAAD(Buffer.from(context));const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join('.');}
export function unseal(value,key,context){const [version,iv,tag,data]=value.split('.');if(version!=='v1')throw new Error('Unsupported encryption envelope');const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64'),Buffer.from(iv,'base64'));cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');}
