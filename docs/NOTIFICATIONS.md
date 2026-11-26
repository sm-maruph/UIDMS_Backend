# Request notifications

Notifications are saved in the existing `dbo.Notifications` table, inside the
request transaction. No SQL migration or new external service is required.

Recipients:
- A newly submitted/replaced request: only the current eligible reviewer(s).
- After recommendation: the next eligible reviewer(s), using the saved workflow.
- Final reviewer: "approval required"; earlier reviewers: "recommendation required".
- Final approval: IT/active acting IT receives "processing required".
- Employee transfer review: the affected employee, then the first approver after review.
- Workflow reconciliation: the newly current reviewer(s), preserving completed approvals.
- Queries and query responses: their addressed recipient and original author respectively.
- Existing requester decision, processing, completion and secure-delivery updates remain.

Reviewer routing uses `uidms_StepReviewers` and `uidms_EffectiveRoles`, the same
authority functions as request authorization. The notification inbox belongs to
the authenticated user; the client cannot select another user. Opening a request
still uses the normal visibility rules. Deleted requests do not appear.

The bell opens an eight-item paginated inbox. Recent means the rolling calendar
month (`CreatedAt >= DATEADD(month,-1,SYSUTCDATETIME())`). Older records are
logically archived, retained without deletion, and returned only when Archive is
selected. The badge counts all unread recent records, independently of the page.
Archived unread items do not inflate the active badge. Read status is preserved.

## Desktop alerts

Each user selects **Enable desktop alerts** in the bell panel and allows the
browser's permission request. Trusted HTTPS (or localhost) is required. A
self-signed HTTPS certificate that the browser does not trust may prevent alerts.
Windows/browser notifications must also be enabled; Focus Assist/Do Not Disturb
can suppress banners. No email or push provider credentials are needed.

This implementation delivers desktop notifications while the user is signed in
and the UIDMS browser tab remains open, including a minimized/background tab.
It uses an authenticated lightweight feed every 15 seconds, with retry/backoff.
Browser sleep/throttling and disconnected PCs can delay delivery. This is not
closed-browser Web Push; it deliberately sends nothing after session expiry or
logout. Background GETs do not extend the session. OS banners contain generic
text, not query content, employee details, or credentials. Clicking opens UIDMS.
Alerts are grouped per poll; the inbox retains every individual notification.

Signing in initializes the cursor silently rather than replaying old messages.
An ascending bigint cursor drains bursts without skipping rows; local per-user
ID claims and the Web Locks API suppress duplicate desktop alerts in multiple
tabs where supported. The persisted setting and cursor contain no session token
or notification content. The browser's notification permission can be revoked
in site settings. The user can also disable alerts from the bell panel.

## Deploy on the hosted server

Deploy backend source and the frontend build from this revision together.
No database reset, seed import, migration or additional npm package is needed.
From Command Prompt, assuming the repositories are under `C:\UIDMS`:

```cmd
cd /d C:\UIDMS\frontend
npm ci
npm run build
cd /d C:\UIDMS\backend
pm2 restart uidms-api --update-env
```

IIS must serve this frontend's `dist` and proxy `/api/*` to the Node backend as
already configured. Existing backend login options, SQL connection, AD and TLS
settings remain required. Do not replace the server's private `.env`.

Verify with two test accounts: submit a request, confirm that only its current
reviewer sees the attention alert; recommend and check the next reviewer; raise
a query and reply; verify eight-row pages and Archive; deny/allow notification
permission; minimize the browser; sign out and confirm no further alerts.
