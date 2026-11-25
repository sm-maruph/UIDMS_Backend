# Reviewed administrative deletion

Admin and Super Admin can delete branches, departments, designations, users and requests after reviewing dependencies. Deletion removes records from active portal lists while retaining database rows required by historical requests and append-only audit records. It is not a database purge or an instruction to deprovision external accounts.

## Deploy

1. Back up the hosting database using the usual DBA procedure.
2. Run `sql/017-reviewed-deletion.sql` in SSMS against the UIDMS instance after migration 016. It adds nullable `DeletedAt` columns to Users and Lookups, enforces inactivity for removed records, and grants the runtime role permission to remove current organization approver mappings. It does not remove existing data or reset the database login password.
3. Confirm `SELECT MAX(Version) FROM CBC_UIDMS.dbo.SchemaVersions;` returns **14**.
4. Rebuild the frontend in the project used by IIS and restart `uidms-api`. The new API requires schema 14. Changes or migrations on a development PC do not deploy to another PC.

## Use

- **Admin settings -> Branches, departments & designations -> Delete**: inspect employees, linked requests, manager/head assignments, acting appointments and related-data counts. Keep employees by moving them to an active entry of the same kind, or explicitly remove them. Choose whether linked requests remain available.
- **Admin settings -> employee list -> Delete**, or **Edit user -> Delete user**: inspect requests created by the user. Keep those requests or remove them. Requests requiring the employee's outstanding review, employee review or query response must be reassigned first or explicitly selected for removal using the additional dependency option.
- **Request details -> Delete with dependencies**: review and remove a request, including requests beyond the ordinary requester's unreviewed-pending cancellation permission.
- Confirmation requires the exact displayed name/ticket number and the dependency acknowledgement. Lists are searchable/paginated. Reload review if linked data changes.

The server independently recomputes dependencies inside a serializable transaction. The review fingerprint includes identities, row versions, assignments and related counts. Changed dependencies return `DELETE_DEPENDENCIES_CHANGED` without performing the deletion. The server does not accept a client-supplied cascade list. A review is bounded to 5,000 employees/requests; larger sets must be handled in smaller groups first.

## Merge duplicate organizations without deleting requests

For duplicate branches such as **Corporate Office -> Head Office BD**, choose **Keep employees and move them**, select **Head Office BD**, keep linked requests, and enable **Merge this branch into Head Office BD and keep all requests**. The same option is available for duplicate departments. Confirm the source name and the dependency acknowledgement.

This explicit merge moves current employee references and unfinished request organization references, request-person references and pending step scopes. Existing pending assignees/roles are preserved; it does not replace or repeat completed decisions. Completed/rejected/cancelled requests, submitted forms, snapshots, signatures, conversation records, access grants and completed step scopes remain historical. Each changed request receives a revision snapshot, a new row version and an audit event. Other department/head assignments owned by moved employees remain attached. The retired source scope's assignment is recorded in merge audit metadata before retirement; the replacement's existing assignment remains authoritative for future requests.

If a waiting manager/head step would have no eligible reviewer, the merge is rejected with the ticket numbers. Fix that request's approver/workflow, reload the review and try again. Scheduled/active acting appointments on the retired scope must be ended or reassigned first. Any merge error rolls back employee moves, request changes and source retirement together. Merely choosing a replacement without enabling merge continues to block unresolved pending scope dependencies. There is no additional SQL migration beyond 017 for this option.

## Effects and safeguards

- Removed organizations become inactive and disappear from administration/catalog lists. Existing historical foreign keys and names remain intact. Linked retained employees move by reference to the selected replacement; their submitted request snapshots remain historical.
- Removed employees become inactive and disappear from the employee directory. Their AD identity/employee ID remains reserved, preventing automatic enrollment from restoring the removed account. Sessions are revoked, challenges and mailing memberships removed, MFA secrets cleared and acting authority ended. Existing decisions, access inventory and audit attribution remain traceable.
- Pending steps referencing removed organizations or users cannot remain orphaned. The review blocks removal until those requests are removed or the pending responsibility is changed through existing workflow/assignment tools. A workflow without a pending dependency may retain the request.
- Removed requests receive `DeletedAt`; unfinished requests become Cancelled. Completed/rejected states remain historical. Supporting forms, items, attachments, queries, decisions and revisions remain linked but are unavailable through ordinary deleted-request routes. Protected credential deliveries are cleared. Deleting a request does not revoke access previously fulfilled from it.
- Current approver mappings for removed users/scopes are removed and applicable acting appointments are revoked. Historical decision actors remain unchanged.
- Own-account deletion, including an organization cascade containing the operator, is forbidden. At least one active Super Admin must remain. All successful removals write audit events in the same transaction.
- Administrative authorization, at least 10 minutes remaining in the session, JSON validation, trusted Origin and CSRF remain required. With the default 30-minute total duration, deletion is available during approximately the first 20 minutes. Continuing inactivity does not extend the total duration. Other sensitive administration actions keep their separate recent-sign-in rule. Names/IDs are typed parameters; client input cannot select tables or columns.
- External AD/banking/file-server/mailbox accounts and previously queued/sent email are not changed or recalled by this operation. Access inventory is evidence, not confirmation that external access was revoked.
- Retained rows reserve their names/employee IDs. Reusing a removed identity or merging an old organization requires an explicit DBA-reviewed retention/migration procedure; there is no automatic name reuse or restore endpoint.

## API

`GET /api/admin/deletions/:kind/:id` returns `{kind,target,users,requests,assignments,acting,counts,reviewToken}`. Kinds are `user`, `request`, `branch`, `department`, `designation`. The response contains safe review fields, not credentials or form payloads.

`DELETE /api/admin/deletions/:kind/:id` accepts:

```json
{
  "reviewToken": "64-character hash from review",
  "confirmName": "Exact displayed name or ticket number",
  "employees": "move",
  "replacementId": null,
  "requests": "keep",
  "deleteOtherRequests": false
}
```

`employees` is `move` or `delete` for an organization. `replacementId` must be an active entry of the same kind when keeping linked employees. `requests` is `keep` or `delete`; for a user, it applies to their own submitted requests. `deleteOtherRequests` additionally removes live requests requiring a removed employee's action. A direct request deletion removes just that request. The response reports deleted user/request counts and retained request counts.

Optional `mergePending:true` enables the duplicate branch/department merge. It requires `employees:"move"`, `requests:"keep"`, a replacement of the same kind and `deleteOtherRequests:false`. The response also includes `mergedRequests`. Source acting-cover conflicts return `MERGE_ACTING_APPOINTMENTS`; missing eligible pending reviewers return `MERGE_APPROVER_REQUIRED`. Neither error commits partial changes.

## Verification

HTTP tests cover authorization, the 10-minute remaining-time threshold, strict input validation and last-Super-Admin protection. Frontend tests cover selection outcomes and blockers. The optional local SQL test creates isolated fixture records and rolls them back:

```powershell
$env:UIDMS_SQL_DELETE_SMOKE='true'
node --env-file=.env --test test/admin-deletions.sql.test.js
Remove-Item Env:UIDMS_SQL_DELETE_SMOKE
```
