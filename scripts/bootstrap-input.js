import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';

export async function bootstrapInput(env=process.env){
 const value={employeeId:env.BOOTSTRAP_EMPLOYEE_ID,name:env.BOOTSTRAP_NAME,email:env.BOOTSTRAP_EMAIL,password:env.BOOTSTRAP_PASSWORD};
 if(Object.values(value).every(Boolean))return value;
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Run npm run admin:bootstrap in an interactive PowerShell/Windows Terminal, or set the BOOTSTRAP_* environment variables described in README.md.');
 let hidden=false;
 const output=new Writable({write(chunk,encoding,callback){if(!hidden)process.stdout.write(chunk,encoding);callback();}});
 const prompt=createInterface({input:process.stdin,output,terminal:true});
 try{
  console.log('Create the first UIDMS portal administrator. This is separate from the SQL database login.');
  if(!value.employeeId)value.employeeId=await prompt.question('Employee ID: ');
  if(!value.name)value.name=await prompt.question('Full name: ');
  if(!value.email)value.email=await prompt.question('Work email: ');
  if(!value.password){
   process.stdout.write('Portal passphrase (15+ characters; input hidden): ');hidden=true;
   value.password=await prompt.question('');hidden=false;process.stdout.write('\n');
   process.stdout.write('Confirm passphrase (input hidden): ');hidden=true;
   const confirmation=await prompt.question('');hidden=false;process.stdout.write('\n');
   if(value.password!==confirmation)throw new Error('Passphrases do not match. No account was created.');
  }
  return value;
 }finally{hidden=false;prompt.close();output.end();}
}
