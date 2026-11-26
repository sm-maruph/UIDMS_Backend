import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {seal,unseal} from '../../core/crypto.js';
export const defaultGoogleTokenFile=fileURLToPath(new URL('../../../private/gmail-token.json',import.meta.url));
export function googleTokenStore(config,file=defaultGoogleTokenFile){
 const context=`gmail:${config.GMAIL_SENDER_EMAIL.toLowerCase()}:${config.GOOGLE_CLIENT_ID}`;
 return {
  async read(){try{const record=JSON.parse(await readFile(file,'utf8'));if(record.version!==1)throw new Error('Invalid Google token record');const stored=JSON.parse(unseal(record.ciphertext,config.DATA_ENCRYPTION_KEY,context));if(stored.email!==config.GMAIL_SENDER_EMAIL.toLowerCase()||typeof stored.refreshToken!=='string'||!stored.refreshToken)throw new Error('Google token account mismatch');return stored;}catch(error){if(error.code==='ENOENT')return null;throw new Error('Google token storage could not be opened. Check its encryption key and file permissions.');}},
  async write(value){
   await mkdir(dirname(file),{recursive:true,mode:0o700});
   const temporary=file+'.'+randomUUID()+'.tmp';
   try{await writeFile(temporary,JSON.stringify({version:1,ciphertext:seal(JSON.stringify(value),config.DATA_ENCRYPTION_KEY,context)}),{flag:'wx',mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
  },
 };
}
