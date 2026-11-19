export const localLoginEnabled=config=>(config.AUTH_MODE||'local')!=='ad';
export const adLoginEnabled=config=>config.LDAP_ENABLED===true&&['hybrid','ad'].includes(config.AUTH_MODE);
export const providerEnabled=(config,provider)=>provider==='ad'?adLoginEnabled(config):provider==='local'&&localLoginEnabled(config);
