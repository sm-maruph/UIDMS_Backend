# Request print and PDF documents

On request details, **Print / Download** offers **Print request** and **Download PDF** for CITO, IT, Admin and Super Admin. A valid acting IT/CITO role receives the same capability during its authorized period. Other roles, including COO, do not gain document-generation permission from appearing in the approval record.

The document includes the ticket, service, status, requester/time, branch/department, beneficiaries, requested systems/roles, justification, submitted form fields, available HR clearance/processing details, decisions/remarks, query responses and supporting-document metadata. Supporting attachment contents are not embedded. Protected credential deliveries, passwords, token/secret fields and signature data URLs are excluded. PDF files are generated in memory and downloaded to the browser; they are not stored on the API server.

Print and PDF share a bordered form header: the blue/green UIDMS logo on the left, **Commercial Bank of Ceylon PLC / Bangladesh Operations** centered, and the existing bank logo on the right. A divider separates the branding from **User ID Request Form - [service]** and the form instruction. Unlock / Reset uses a verification instruction rather than falsely requiring justification. Both PNGs are embedded from `assets/branding`; deploy that directory with the backend. The print action waits for image decoding before opening the print dialog. [Header preview](images/request-header-preview.png).

The final sign-off row is laid out side by side on landscape A4: requester, branch manager/department head if present, HR if present, IT if applicable, CITO and COO if present in the saved workflow. Names and decision times come from recorded actors, not the current assigned reviewer. Waiting steps show the assigned name when available with **Pending** and no invented decision timestamp. An IT processing entry uses the recorded processing/completion actor and time when available. Rejected decisions retain their actual status. Times display in Asia/Dhaka.

The print window is a standalone document and opens the browser print dialog. PDF downloads are actual PDF files generated using PDFKit. The print layout does not include the portal sidebar, chat bubble or other interface controls. HTML text is escaped, and the PDF does not fetch user-supplied remote resources. Fonts use Windows Nirmala when available; otherwise PDFKit's standard Helvetica font is used. If multilingual text is used, verify the hosting OS font coverage in the generated PDF.

`GET /api/requests/:id/document?format=pdf` returns an attachment named after the ticket. `format=html` supplies the print-window markup. Both enforce current effective role and existing ticket visibility; deleted or inaccessible tickets return 404. The normal session, no-store response and API rate-limit protections apply. Successful generation records `request.document_generated` with ticket and format in the audit trail; this records generation, not proof of a physical print or a completed local save.

## Deploy

Pull the backend and frontend changes. In `backend`, run `npm ci` to install the lockfile's PDFKit dependency. Rebuild `frontend` with `npm run build` and restart `uidms-api`. No new SQL migration or environment variable is required for this feature.

Tests cover role restrictions, deleted requests, actual decision attribution, honest pending labels, secret exclusion, HTML escaping and multi-page PDFs. Browser checks exercise the print popup, aligned sign-off columns, actual PDF download and mobile menu. The optional local SQL test creates and rolls back isolated data:

```powershell
$env:UIDMS_SQL_DOCUMENT_SMOKE='true'
node --env-file=.env --test test/request-document.sql.test.js
Remove-Item Env:UIDMS_SQL_DOCUMENT_SMOKE
```


Designation fields use professional job titles, independently of UIDMS roles.
A valid submitted job title is preserved; designation IDs are resolved through
lookups, with the employee directory as a fallback for old role-valued records.
Super Admin/Admin/User permission labels are not used as job designations.
If no job title is available, the document says "Not recorded". Assign the real
title in Edit profile or User directory; this does not change the employee's
portal permissions. Requester and beneficiary designation columns are included
in both the printed HTML and downloadable PDF. No database migration is needed.
