# Department and branch approvers

Super Admin, Admin and IT can open **Approver assignments** at `/admin/approvers`. Choose **Departments** or **Branches**, select the scope, enter the existing employee's system ID, click **Find user**, confirm the employee, then assign them. For timed leave cover and the current installation steps, see [roles and acting appointments](ROLES-AND-ACTING.md).

Each department has one head and each branch has one manager. The same account may cover multiple scopes. An assignment does not change the account's portal role, department, branch, AD identity or system access. Only active, registered UIDMS users may be selected. New AD employees first complete their ordinary UIDMS enrollment.

Assignments use exact lookup IDs. If both `IT` and `IT Department` exist, assigning a head to `IT` does not cover requests stored against `IT Department`. Workflow save errors now identify all affected scopes and ticket numbers. Use Set assignment to open the exact scope in another tab. An unassigned department can suggest the employee assigned to an unambiguous similarly named record; Find user and Assign are still required. No department records are automatically merged and no employee is silently assigned to another scope.

Assignments are used when the configured service workflow includes **Manager**. Existing routing determines whether the target organization requires a department head or branch manager. Branch/department movements use the destination scope; other services use the requested employee scope. A service configured as CITO → Processing → Completed remains on that chain until its workflow is changed to include Manager.

Assigned accounts get the Approvals menu and pending badge even if their base role is User. The server checks the exact assigned account and prevents approval of the requester's or movement subject's own request. Holding a Manager assignment does not grant general user administration or workflow editing.

Saving an assignment replaces only matching Waiting manager/head steps on Employee review, Pending, In review and Query requests. Completed approvals, recorded actors and remarks remain unchanged. Approved, processing and closed requests remain unchanged. Active queries remain paused until answered. Each affected request gets a new row version. Concurrent edits require a reload; all successful changes are audited in the same transaction.

## Update an existing installation

1. Pull the updated backend and frontend on the hosted PC.
2. In SSMS, connect to the UIDMS SQL instance using a DBA account and execute the complete `backend/sql/014-organization-approvers.sql`. Migration 013 must already be installed. Script 014 is transactional and can be rerun safely. It adds mapping/assignee fields and seeds only unique existing active manager/head accounts. It preserves user roles and completed approvals.
3. Also run migration 015 for acting roles and Admin. Confirm `SELECT MAX(Version) FROM CBC_UIDMS.dbo.SchemaVersions;` returns **13** after migration 016. Script 004 and the runtime login password do not need to be changed.
4. Rebuild the frontend with `npm run build` from its directory and restart only the UIDMS API process, for example `pm2 restart uidms-api` from the backend directory. Keep IIS pointing to the updated frontend `dist` directory.
5. Sign in as Super Admin or IT, open Approver assignments, and review all relevant departments/branches. Use Workflow studio as Super Admin to include Manager in the services that require it.

The running API fails at startup with an explicit migration instruction until the current schema version 13 (migration 016) is installed. The API does not perform database migrations automatically. Applying scripts to a development database does not update a different hosted database.

## API

- `GET /api/approver-assignments`: IT/Admin/Super Admin only. Returns active scopes and nullable current assignees, including employee ID, name, active status and mapping Version.
- `PUT /api/approver-assignments/:scopeId`: IT/Admin/Super Admin, fresh authentication, session cookie, allowed Origin and CSRF token. Body: `{ "employeeId": "BD06653", "version": null }` for a first assignment, or the existing hexadecimal Version to replace it. Returns `{ "updatedRequests": 3 }`.

SQL parameters are typed. Unknown fields are rejected. Inactive/missing users, invalid scope kinds and stale versions are rejected before any write. A stale assignment returns `409 STALE_ASSIGNMENT`; use Reload before retrying. Missing/ambiguous manager routing returns `409 APPROVER_REQUIRED`; an explicitly inactive assignee returns `409 APPROVER_INACTIVE`.

Request lists include `assignedUserId`. Ticket workflow steps include `assignedUserId`, `assignedName` and `assignedEmployeeId`. Reviewable ticket details also provide minimal server-authorized `queryParticipants`, so assigned heads/managers can query the requester and eligible earlier reviewers without receiving broad employee-directory access.

## Verification

Run the ordinary backend and frontend tests. To additionally run isolated, rollback-only SQL verification against a local development instance:

```powershell
$env:UIDMS_SQL_APPROVER_SMOKE='true'
node --env-file=.env --test test/approver-assignments.sql.test.js
Remove-Item Env:UIDMS_SQL_APPROVER_SMOKE
```

The fixture checks branch and department assignments, multiple scopes, unchanged portal roles, exact-ID authorization, approval lists, query participants, stale writes, reassigned pending steps and preserved completed decisions. Its users, requests and assignments roll back; it does not authenticate against AD or send email.
