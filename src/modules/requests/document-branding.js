import {readFileSync} from 'node:fs';

// Local, versioned assets keep print/PDF documents independent of the frontend
// deployment path and prevent remote image requests during generation.
export const bankLogo=readFileSync(new URL('../../../assets/branding/cbc-bank-logo.png',import.meta.url));
export const uidmsLogo=readFileSync(new URL('../../../assets/branding/uidms-logo.png',import.meta.url));
export const bankLogoData='data:image/png;base64,'+bankLogo.toString('base64');
export const uidmsLogoData='data:image/png;base64,'+uidmsLogo.toString('base64');
export const formTitle=report=>'User ID Request Form - '+String(report.title||'Request').replace(/\b[a-z]/g,value=>value.toUpperCase());
export const formInstruction=report=>report.requiresJustification===false?'Complete all sections. Verify the request details before processing.':'Complete all sections. Business justification is mandatory.';
