import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
async function files(directory){return(await Promise.all((await readdir(directory,{withFileTypes:true})).map(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):entry.name.endsWith('.js')?[path.join(directory,entry.name)]:[]))).flat();}
const root=fileURLToPath(new URL('..',import.meta.url));
const sources=[...await files(path.join(root,'src')),...await files(path.join(root,'scripts'))];
for(const file of sources){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status){process.stderr.write(result.stderr);process.exit(1);}}
await import('../src/app.js');
console.log(`${sources.length} JavaScript files passed syntax and API import checks.`);
