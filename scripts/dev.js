import {watch,watchFile,unwatchFile} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';

// Watch the exact environment file; directory-wide watch mode also picks up logs/.git on Windows.
export function startDevelopment({root=fileURLToPath(new URL('..',import.meta.url)),onOutput,pollInterval=300,debounceMs=200}={}){
 const envFile=join(root,'.env');let child,timer,restartRequested=false,closing=false,closePromise;
 const log=value=>{if(!onOutput)console.log(JSON.stringify(value));};
 function launch(){
  if(closing)return;
  const processHandle=spawn(process.execPath,['--env-file='+envFile,join(root,'src','server.js')],{cwd:root,windowsHide:true,stdio:onOutput?['ignore','pipe','pipe']:'inherit'});
  child=processHandle;
  if(onOutput){processHandle.stdout.on('data',data=>onOutput(String(data)));processHandle.stderr.on('data',data=>onOutput(String(data)));}
  processHandle.on('error',error=>log({event:'dev.start_failed',code:error.code}));
  processHandle.on('exit',()=>{
   if(child===processHandle)child=undefined;
   if(restartRequested&&!closing){restartRequested=false;launch();}
   else if(!closing)log({event:'dev.waiting_for_changes'});
  });
 }
 function changed(){
  clearTimeout(timer);timer=setTimeout(()=>{
   if(closing)return;
   if(child&&child.exitCode===null){restartRequested=true;child.kill();}
   else launch();
  },debounceMs);
 }
 const sourceWatcher=watch(join(root,'src'),{recursive:true},(event,file)=>{if(file?.toString().endsWith('.js'))changed();});
 sourceWatcher.on('error',error=>log({event:'dev.watch_failed',code:error.code}));
 watchFile(envFile,{interval:pollInterval},(current,previous)=>{if(current.mtimeMs!==previous.mtimeMs||current.size!==previous.size)changed();});
 launch();
 return {close(){
  if(closePromise)return closePromise;
  closing=true;clearTimeout(timer);sourceWatcher.close();unwatchFile(envFile);
  closePromise=new Promise(resolveClose=>{
   if(!child||child.exitCode!==null){resolveClose();return;}
   child.once('exit',resolveClose);child.kill();
  });return closePromise;
 }};
}

if(resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
 const controller=startDevelopment();
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void controller.close();});
}
