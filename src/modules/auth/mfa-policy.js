// A development-only pause preserves enrolled authenticators for later reactivation.
export const mfaPausedForTesting=config=>config.NODE_ENV==='development'&&config.MFA_REQUIRED===false;
export const mfaRequiredForUser=(config,user)=>config.NODE_ENV==='production'||!mfaPausedForTesting(config)&&Boolean(config.MFA_REQUIRED||user.MfaSecret);
