// Optional ClamAV worker. Configure an absolute clamscan executable path in the service environment.
// Never accepts an executable, command, path, or scanner arguments from an HTTP request.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readConfig} from '../src/config.js';
import {createDatabase,p} from '../src/core/db.js';
import {audit} from '../src/modules/audit/service.js';
const scanner=process.env.CLAMSCAN_PATH;
if(!scanner||!path.isAbsolute(scanner))throw new Error('Set CLAMSCAN_PATH to an absolute, administrator-controlled clamscan executable path.');
const db=createDatabase(readConfig());
try{
 await db.connect();
 const files=(await db.query("SELECT TOP(20) Id,Bytes,Sha256 FROM dbo.Attachments WHERE ScanStatus='Quarantined' ORDER BY CreatedAt")).recordset;
 for(const file of files){
  const directory=await mkdtemp(path.join(tmpdir(),'uidms-scan-'));
  try{
   const filename=path.join(directory,'document.bin');await writeFile(filename,file.Bytes,{mode:0o600});
   let clean=false,infected=false;
   try{await promisify(execFile)(scanner,['--no-summary',filename],{timeout:60000,windowsHide:true,maxBuffer:65536,shell:false});clean=true;}catch(error){infected=error.code===1;}
   if(!clean&&!infected){console.error(JSON.stringify({event:'attachment.scan_unavailable',id:file.Id}));continue;}
   await db.transaction(async query=>{
    await query("UPDATE dbo.Attachments SET ScanStatus=@status,ScanReference=@reference WHERE Id=@id AND ScanStatus='Quarantined'",{status:p.str(clean?'Clean':'Rejected',15),reference:p.text(`ClamAV ${new Date().toISOString()} SHA256 ${file.Sha256}`,300),id:p.id(file.Id)});
    await audit(query,{id:randomUUID(),ip:'local-scanner'},'attachment.scanned',file.Id,{clean,sha256:file.Sha256});
   });
  }finally{
   if(path.dirname(path.resolve(directory))!==path.resolve(tmpdir())||!path.basename(directory).startsWith('uidms-scan-'))throw new Error('Temporary directory safety check failed');
   await rm(directory,{recursive:true,force:true});
  }
 }
}finally{await db.close();}
