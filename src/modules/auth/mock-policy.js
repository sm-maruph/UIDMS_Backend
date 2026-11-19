export const isLoopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
export const mockModeEnabled=config=>config.AUTH_MODE!=='ad'&&config.NODE_ENV==='development'&&config.MOCK_LOGIN_ENABLED===true&&['127.0.0.1','localhost','::1'].includes(config.HOST);
export const localMockRequest=(config,req)=>mockModeEnabled(config)&&isLoopback(req.socket?.remoteAddress);
export const mockLoginAllowed=(config,req,user)=>Boolean(user?.IsDemo)&&localMockRequest(config,req);
