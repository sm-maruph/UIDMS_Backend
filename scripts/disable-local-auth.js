import {randomUUID} from 'node:crypto';
import {readConfig} from '../src/config.js';
import {createDatabase} from '../src/core/db.js';
import {retireLocalAuthentication} from '../src/modules/auth/local-retirement.js';

const config=readConfig();
if(config.AUTH_MODE!=='ad')throw new Error('Set AUTH_MODE=ad before retiring local credentials.');
if(!process.argv.includes('--apply')){console.log('Removes local password hashes, demo flags, local sessions and local challenges. Keeps all users, roles, grants and requests. Run with --apply to execute.');process.exit(0);}
const db=createDatabase(config);
try{await db.connect();console.log(JSON.stringify(await retireLocalAuthentication(db,{id:randomUUID(),ip:'ad-only-cutover'})));}
finally{await db.close();}
