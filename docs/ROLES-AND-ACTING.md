# Roles, organization responsibilities and leave cover

## Verified role model

| Requirement | Behavior |
| --- | --- |
| First AD sign-in | A verified, previously unregistered employee completes profile enrollment and receives only User. The client cannot choose a role, identity or access grants. Existing accounts retain their saved permissions. |
| Department heads | Each department has one assigned head. The same employee can head multiple departments independently. |
| Branch managers | Each registered branch has one assigned manager. This includes all configured branches; no branch count is hardcoded. |
| Assign permanent heads/managers | IT, Admin and Super Admin select an active registered employee by system ID in Approver assignments. |
| Request routing | When a service workflow contains Manager, the ticket goes to its assigned branch manager or department head using the existing target-organization rules. Movement requests use their destination. A service without Manager retains its configured flow. |
| Scoped visibility and recommendation | Permanent and currently acting heads/managers see relevant branch/department requests. Only the current workflow approver can recommend, reject or query; configuration access does not bypass approval assignment or self-approval restrictions. |
| Manager/head leave cover | A permanent manager/head can appoint their own replacement for one of their assigned scopes. A branch replacement must belong to that branch; a department replacement must belong to that department. IT, Admin and Super Admin can also make these appointments. |
| IT/CITO leave cover | The permanent IT or CITO user may appoint their own replacement. Admin and Super Admin may appoint replacements for either role. IT cannot appoint CITO cover unless they are also an administrator or that permanent CITO holder. |
| Change permanent IT/CITO roles | Admin and Super Admin can change another employee's ordinary business role through Organization setup. |
| Create administrators | Only Super Admin can create, promote or reactivate Admin/Super Admin accounts. Admin may maintain or demote existing administrators, but cannot create new administrator authority or promote Admin to Super Admin. The last active Super Admin remains protected. |
| Admin functions | Admin has the same ordinary administration, existing-account management, workflow, catalog, organization, email-template, audit and processing tools as Super Admin, with the administrator-grant exception above. |
| Directly change own system access | Only IT, Admin and Super Admin, including a currently authorized acting IT user. Ordinary Users, managers, heads, HR and CITO must request access through approval. Development/mock accounts have no exception. |

Permanent portal roles and organizational responsibilities are distinct records. An employee can remain `Users.Role=User` while being assigned one or several head/manager responsibilities. Their signed-in profile exposes the effective roles and managed scopes, and displays the relevant responsibility. No duplicate AD account is created. IT/CITO acting appointments temporarily add the corresponding authority without changing the replacement's permanent role.

Employees cannot directly change their own permanent portal role through profile editing or the user-administration API. The system-access exception for IT/Admin/Super Admin concerns the system access inventory, not permission to promote oneself to another portal role.

## Use the screens

1. **Approver assignments:** IT/Admin/Super Admin choose Departments or Branches, select a scope, find an employee by exact system ID and confirm the assignment. Repeat for another department if the same person heads it.
2. **Admin settings → Organization setup:** Admin/Super Admin enter an existing employee's system ID and edit their permanent business role, including IT or CITO. Admin can maintain an existing administrator without granting administrator authority to another employee; only Super Admin sees new administrator creation/promotion choices. Existing organization assignments stay separately managed in Approver assignments.
3. **Acting appointments:** Select the responsibility and permanent holder, find the replacement by system ID, and choose start/end dates and times. Times in this screen are **Asia/Dhaka (UTC+06:00)**. Save, or use End appointment to cancel early.

A manager/head's responsibility selector contains only their own permanent scopes. Administrators see the authorized wider set; IT sees scopes it may administer and its own permanent IT responsibility. A person who holds only acting authority cannot delegate that acting responsibility again. Appointments can be scheduled ahead, last up to one year, and cannot overlap another appointment for the same permanent holder, role and scope. Global IT/CITO acting chains and cycles are rejected.

During the selected period, the replacement receives the relevant role/scope functions and the absent holder's authority for that responsibility is suspended. Other responsibilities the permanent holder retains are independent. At the exact end time, authority returns automatically, without a scheduler, restart or new sign-in. API requests re-evaluate SQL authority; the frontend refreshes roles, badges, assignments and selected ticket actions on its regular live refresh and focus.

Signed-in replacements lose expired/revoked authority on their next API request. Inactive accounts and out-of-scope transfers cannot retain acting head/manager authority. Changing a permanent business role or replacing a scope owner ends applicable appointments. Existing completed recommendations keep the actual actor, remarks and time. An appointment's status can be Scheduled, Active, Expired, Ended or Unavailable.

## Update the hosted installation

1. Pull both repositories on the hosted PC. This workspace's changes and local database updates do not update another machine automatically.
2. In SSMS, run `backend/sql/015-roles-and-acting-assignments.sql` against the UIDMS instance using the DBA account. Migration 014 must already be installed. Run the complete script. It is transactional and safe to rerun after successful installation.
3. Verify `SELECT MAX(Version) FROM CBC_UIDMS.dbo.SchemaVersions;` returns **12**. No runtime-login password change or rerun of script 004 is needed.
4. Rebuild the frontend with `npm run build`, keep IIS pointed to its current `dist`, and restart only UIDMS: `pm2 restart uidms-api`.
5. Sign in as Admin/Super Admin to review organization assignments and business roles. Permanent holders can then configure their own Acting appointments.

Migration 015 adds Admin and the acting appointment table/functions. Existing Platform Admin accounts become Admin; their other data stays intact. One-per-scope assignments remain unchanged. The API requires schema version 12 at startup and does not apply migrations itself.

## API and stored records

- `GET /api/acting-options`: responsibilities this authenticated user may delegate, with permanent holder, role and nullable scope.
- `GET /api/acting-candidates?principalId=...&role=...&scopeId=...&search=BD06653`: exact system-ID lookup restricted to an authorized responsibility and its permitted replacement scope; omit scopeId for IT/CITO.
- `GET /api/acting-assignments`: own incoming/outgoing appointments, or the wider scope the operator may administer.
- `POST /api/acting-assignments`: `{principalId,employeeId,role,scopeId,startsAt,endsAt}`; timestamps are ISO-8601 with an explicit offset or Z, scopeId is null for IT/CITO. Requires recent authentication, valid Origin and CSRF token.
- `POST /api/acting-assignments/:id/end`: `{version}` with the current hexadecimal row version; same session protections and responsibility checks.

`RoleDelegations` records principal, replacement, role, scope, start/end, creator, revocation and row version. Database functions compute effective roles, managed scopes and eligible step reviewers. The ordinary scope assignment still uses OrganizationApprovers and the ticket's exact AssignedUserId. Every successful create/end/configuration write is audited. Invalid roles, out-of-scope staff, stale writes, overlaps, cycles and unregistered/inactive users are rejected.

Profile/session responses include `baseRole`, `role`, `roles`, `managedScopes`, `canApproveRequests` and `canManageActing`. Request list/detail `reviewableByMe` comes from current server authority; it overrides cached permanent-assignee display logic. Actual actors on historical steps remain unchanged.

These controls manage UIDMS authorization and the recorded system-access inventory. Assigning an IT role does not independently provision accounts in external banking, AD or email systems.

## Verification

Ordinary backend/frontend tests cover the role matrix, self-access restrictions, interval conversion, delegation rules and current recommendation capability. A rollback-only SQL test covers branch and department leave cover, a head managing multiple departments, schedule/expiry/revocation, exact reviewer lists, actual acting decision attribution, IT/CITO functions, Admin role protection, role/scope replacement, and expiry inside an existing AD-backed session using an injected test directory.

```powershell
$env:UIDMS_SQL_ROLE_SMOKE='true'
node --env-file=.env --test test/role-model.sql.test.js
Remove-Item Env:UIDMS_SQL_ROLE_SMOKE
```

The test creates isolated fixture users, organizations, requests and assignments and rolls them back. It never contacts the real directory or sends external email. Browser interaction checks exercise valid/unknown system IDs, date errors, creating and ending appointments, and desktop/mobile light/dark layouts.
