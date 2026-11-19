import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startDevelopment} from '../scripts/dev.js';

test('development reloads saved environment/source changes and ignores unrelated logs',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'uidms-dev-'));let controller;
 const source="console.log(JSON.stringify({value:process.env.UIDMS_WATCH_VALUE,pid:process.pid}));setInterval(()=>{},1000);";
 const rows=[];let buffered='';
 const waitFor=condition=>new Promise((resolve,reject)=>{
  const deadline=Date.now()+4000;const timer=setInterval(()=>{if(condition()){clearInterval(timer);resolve();}else if(Date.now()>deadline){clearInterval(timer);reject(new Error('Development watcher did not reload.'));}},20);
 });
 try{
  await mkdir(join(root,'src'));await writeFile(join(root,'.env'),'UIDMS_WATCH_VALUE=first\n');await writeFile(join(root,'src','server.js'),source);
  controller=startDevelopment({root,pollInterval:50,debounceMs:30,onOutput:data=>{buffered+=data;const lines=buffered.split('\n');buffered=lines.pop();for(const line of lines){try{const row=JSON.parse(line);if(row.pid)rows.push(row);}catch{}}}});
  await waitFor(()=>rows.length===1);assert.equal(rows[0].value,'first');
  await writeFile(join(root,'.env'),'UIDMS_WATCH_VALUE=second\n');await waitFor(()=>rows.length===2);assert.equal(rows[1].value,'second');assert.notEqual(rows[0].pid,rows[1].pid);
  await writeFile(join(root,'unrelated.log'),'Log files must not restart the server.');await new Promise(resolve=>setTimeout(resolve,200));assert.equal(rows.length,2);
  await writeFile(join(root,'src','server.js'),source+'\n// source edit');await waitFor(()=>rows.length===3);assert.equal(rows[2].value,'second');
 }finally{
  await controller?.close();
  for(const file of ['.env','unrelated.log','src/server.js'])await unlink(join(root,file)).catch(()=>{});
  await rmdir(join(root,'src')).catch(()=>{});await rmdir(root).catch(()=>{});
 }
});
