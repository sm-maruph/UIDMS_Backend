# API contract and frontend connection

Base path: `/api`. The API returns JSON, except signature images and clean attachment downloads. The current frontend uses this API for database-backed data and authentication.

All request bodies use strict validation. Unknown top-level properties are rejected. JSON body limit: 512 KiB. All collection endpoints shown with pagination accept `page` (default 1) and `pageSize` (default 20, maximum 100).

Most ticket mutations require `version`, a 16-character hexadecimal SQL `rowversion` returned by ticket reads. After a successful mutation, fetch the ticket again before the next action. A stale version returns `409 STALE_VERSION`. Do not manufacture a new version in the browser.

## Authentication walkthrough

The account selector only selects an ID; the server verifies its password and creates the session. Real accounts use the following MFA flow. The explicitly enabled [local mock mode](MOCK-DATA.md) lets marked test accounts sign in directly with password `1234`.

`GET /auth/options` returns `{mockLogin, localLogin, adLogin}`; the current AD-only values are `{false, false, true}`. Login defaults to `provider: "ad"`, and explicit local login is rejected. After AD verification, the directory-returned employee ID resolves the existing active SQL profile and its current role/access. First login pins the immutable identity; conflicting existing pins are rejected. Unknown profiles receive `{onboardingRequired:true,onboardingToken,profile:{employeeId,name,email},expiresInSeconds:600}` and complete the profile flow below before MFA. This is not a session. Session responses include the provider, preserved through MFA. See [AD setup](AD-SETUP.md).

First-time AD profile setup (after `POST /auth/login`):

| Method | Path | Body / response |
| --- | --- | --- |
| POST | `/auth/onboarding/options` | `{onboardingToken}` returns `{organizations}` containing active branch/department IDs and names only. |
| POST | `/auth/onboarding/complete` | `{onboardingToken,name,branchId,departmentId,email?}` creates the fixed User profile and returns HTTP 201 with the usual MFA `challenge`. Email may be omitted, empty, or null. Employee ID, directory identity, role, and access fields are rejected. |

The token is hashed in SQL, expires in ten minutes, and is single-use on completion. Keep it in memory only. New profiles have no local password or access grants. Existing profiles are not overwritten. Invalid/expired/consumed proofs return `401 ENROLLMENT_EXPIRED`; conflicting profiles/email return `409 PROFILE_ALREADY_EXISTS`. No session cookie is issued until successful MFA verification.

Development testing exception: with `NODE_ENV=development` and `MFA_REQUIRED=false`, login for existing users and HTTP 201 profile completion return `{user,csrfToken,provider}` with the HttpOnly session cookie directly, without an MFA challenge. Clients must handle both session and challenge results. Stored MFA secrets are preserved; restoring `MFA_REQUIRED=true` resumes prompts on the next login. Production rejects this configuration.

`GET /auth/mock-directory` lists active marked test accounts only for an allowed local mock client; otherwise it returns 404. `POST /users` accepts optional `mock: true` for a recently authenticated administrator in local mock mode. It returns `{id, mock: true}` and sets a separately salted `1234` password hash. Ordinary user creation returns an activation token instead.

1. `POST /auth/login`:

   ```json
   {"employeeId":"YOUR_EMPLOYEE_ID","password":"your long passphrase"}
   ```

   With MFA enabled, the response contains `challenge`, `mfaEnrollmentRequired`, and `expiresInSeconds: 300`. This is not a logged-in session. Do not store the challenge in localStorage or a URL.

2. On first login only, `POST /auth/mfa/enroll`:

   ```json
   {"challenge":"the returned challenge"}
   ```

   The response contains a `secret` and `otpauthUrl`. Present it privately as a QR code or setup key for the user's authenticator app. Do not log, cache or persist it client-side. This endpoint cannot replace an already enabled MFA secret.

3. `POST /auth/mfa/verify`:

   ```json
   {"challenge":"the returned challenge","code":"123456"}
   ```

   On success, the server sets its HttpOnly session cookie and returns `{user, csrfToken}`. Keep only the CSRF token and display profile in memory. Session tokens never go into localStorage. MFA codes cannot be replayed once used.

   MFA errors include readable instructions: `401 MFA_INVALID` means an incorrect/expired code; `401 MFA_CODE_USED` asks the user to wait for the next code. `401 CHALLENGE_INVALID` and `401 MFA_ATTEMPTS_EXCEEDED` require a fresh sign-in; `401 MFA_LOCKED` explains the 15-minute wait. `400 MFA_ENROLLMENT_REQUIRED` asks the user to scan the QR first. Failure counters and lockouts are still recorded before returning a code error. The frontend displays these messages in an alert, marks retryable code errors on the input, and offers **Back to sign in** for expired/locked attempts.

4. On page reload, call `GET /auth/session` with credentials to recover the profile and receive a new CSRF token. This rotates the session's CSRF token; synchronize it between tabs if your UI keeps several tabs open. If a tab receives `CSRF_INVALID`, refresh the token with this endpoint before a deliberate retry. Do not automatically replay a non-idempotent submission without checking whether it succeeded.

5. Include `X-CSRF-Token` on every authenticated write. Include the configured exact `Origin` header on writes in Postman/scripts. Browser fetch supplies Origin automatically.

6. `POST /auth/logout` revokes the session in SQL Server and clears the cookie.

One concurrent session is allowed per account. A new successful login revokes previous sessions. Idle timeout defaults to 15 minutes; absolute lifetime is 8 hours. Sensitive administrative operations and credential consumption require a login in the last 10 minutes. Sign in again when `REAUTHENTICATION_REQUIRED` is returned.

Activation: `POST /auth/activate` accepts `{token,password}` only when local login is enabled. It is disabled in this AD-only deployment. Self-enrollment requires a successful AD login, and new profiles always receive the User role.

Password change: `POST /auth/password` accepts `{currentPassword,newPassword}`. It revokes all sessions, including the caller. Sign in again. Passphrases must be 15–128 characters. Bootstrap/admin recovery are controlled operational processes, not anonymous reset endpoints.

## Minimal future frontend client

This is an integration example, not code installed into the frontend:

```js
const API = 'http://localhost:4000/api'; // same hostname as the dev frontend
let csrfToken;

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken && method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) throw data.error;
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}
```

Authenticated POST/PUT/PATCH/DELETE calls with no domain payload should still send `{}` to satisfy the API's JSON content-type policy.

## Identity, directory and reference data

| Method | Path | Body / behavior | Authorization |
| --- | --- | --- | --- |
| GET | `/profile` | Current safe profile, current `access` grants, and `canEditAccess` capability | Signed in |
| PATCH | `/profile` | `{version,designationId,access?,signatureBase64?}`; atomic self-profile update | Self; direct access editing only for IT/Admin/Super Admin; audited |
| GET | `/profile/signature` | Current user's PNG signature (200); no saved signature returns 204 with no body | Self |
| PUT | `/profile/signature` | `{base64}` PNG, max 256 KiB | Self; audited |
| GET | `/lookups` | Organization IDs, systems/roles, request types/workflows, mailing groups | Signed in |
| GET | `/users?page=1&pageSize=20&search=...` | Paginated directory | Self, own managerial scope, operations, or admin scope |
| GET | `/users/:id/access` | Current normalized system access grants | Same directory scope |
| POST | `/users` | New profile; AD-only mode returns `{id,authentication:"ad"}` without a local credential or token | Platform Admin/Super Admin; fresh login |
| PATCH | `/users/:id` | Profile, role, `active`, `version`; employee ID immutable | Admin; no self-administration; Super Admin needed for Super Admin accounts |
| POST | `/lookups` | `{kind,name}`; kind branch/department/designation | Admin; fresh login |
| PATCH | `/lookups/:id` | `{name,active}` | Admin; fresh login |
| POST | `/systems` | `{name,roles:["Inquiry", "Entry"]}` | Admin; fresh login |
| PATCH | `/systems/:id` | `{name,active,transferManaged}` | Admin; fresh login |

New user profile body:

```json
{
  "employeeId": "BD12345",
  "name": "Employee Full Name",
  "email": "employee@combankbd.com",
  "role": "User",
  "branchId": "GUID_FROM_LOOKUPS",
  "departmentId": "GUID_FROM_LOOKUPS",
  "designationId": "GUID_FROM_LOOKUPS_OR_NULL"
}
```

`/lookups` currently returns SQL-style property names for catalogue records (`Id`, `Name`, `SystemId`, `Code`). Request summaries and safe user profiles use camelCase. Resolve catalogue names to these IDs in a frontend adapter; do not send display names in ID fields. New user creation returns `{id,activationToken,expiresInHours}`. Copy the activation token once into your approved secure onboarding process.

## Requests and pagination

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/requests?scope=mine` | Only tickets submitted by the authenticated user, including on-behalf requests |
| GET | `/requests?scope=approvals` | Current review tasks assigned to this actor's role and branch/department; excludes self-approval |
| GET | `/requests?scope=visible` | All tickets visible under the actor's policy |
| GET | `/requests/:id` | Full authorized ticket, normalized people/items, approval/query history, fulfilment, attachment metadata and HR clearance |
| POST | `/requests` | Create; identity, status, routing, sequence and timestamps are generated by the server |
| PUT | `/requests/:id` | Replace an owned, unreviewed pending request using the create body plus `version`; type cannot change |
| PATCH | `/requests/:id` | Update owned, unreviewed pending request `{version,justification,details}`; normalized people/items remain unchanged |
| DELETE | `/requests/:id` | `{version}`; cancel/soft-delete an owned, unreviewed pending request; audit/history retained |
| POST | `/requests/:id/decisions` | `{version,decision:"approve" or "reject",remark?}`; rejection requires remark |
| PUT | `/requests/:id/hr-clearance` | `{version,checks:[{personId,police,reference,recommendation?}]}`; assigned HR only |
| POST | `/requests/:id/employee-review` | Movement employee confirms `{version,justification,details,items:[{systemId,systemRoleId?,reason}]}` |

List filters: `status`, `search`, `sort` (`newest`, `oldest`, `ticket`), `page`, `pageSize`. Status options are `Employee review`, `Pending`, `In review`, `Query`, `Approved`, `IT processing`, `HO processing`, `Completed`, `Rejected`, `Cancelled`. Response: `{items,total,page,pageSize}`.

Submission example:

```json
{
  "typeCode": "upgrade",
  "branchId": "GUID_FROM_LOOKUPS",
  "departmentId": "GUID_FROM_LOOKUPS",
  "justification": "Business access needed for daily operations.",
  "details": {
    "upgradeDetails": {"systems":["ICBS"],"roles":{"ICBS":"Inquiry"}},
    "submittedForm": {"version":1,"data":{"businessReason":"Daily operations"}}
  },
  "people": [{
    "employeeId":"BD12345",
    "name":"Employee Full Name",
    "userId":"EXISTING_USER_GUID",
    "branchId":"GUID_FROM_LOOKUPS",
    "departmentId":"GUID_FROM_LOOKUPS",
    "details":{}
  }],
  "items": [{
    "employeeId":"BD12345",
    "systemId":"ICBS_SYSTEM_GUID",
    "systemRoleId":"INQUIRY_ROLE_GUID",
    "operation":"update",
    "reason":"Role required for assigned responsibilities."
  }],
  "consent":true
}
```

Request `people`, `items`, organization IDs and server steps are authoritative. JSON `details` preserves the existing UI form/snapshot fields; it never authorizes a workflow transition or overrides normalized access items. Keep both representations consistent. Use PUT when editing selected systems or people, not a details-only PATCH.

Use operation `revoke` only for deactivation request types, `reset` only for `reset`, and `grant`/`update` for other requests. Unknown systems, roles from another system, mismatched existing employee identity/scope, duplicate items and mixed approval scopes are rejected. Split cross-branch/department batches into separate requests.

Drive requests remain separate: `idrive` displays **I Drive / S Drive Access** and accepts the `IDrive` or `S Drive` system; `n-drive` displays **N Drive Access** and accepts only `N Drive`. Apply `sql/007-separate-drive-requests.sql` to update an existing catalogue.

Reset/unlock (`typeCode: "reset"`) is a self-service request: submit exactly your own employee record. Justification may be omitted or empty. Its initial default is **User → CITO → Processing → Completed**, and Admin or Super Admin can change its approval roles and order in Workflow studio, like other request types. Other request types still require a justification of at least 10 characters. Migration 005 initializes the CITO-only default; do not rerun it to apply an admin workflow edit.

For `movement`, include `subjectUserId`, source `branchId`/`departmentId`, destination `destinationBranchId`/`destinationDepartmentId`, and one normalized person whose branch/department represent the destination. Only IT/HR may initiate it. The server starts at `Employee review`; the selected employee must confirm destination access before manager approval begins. Other request types must omit the movement-only fields.

For `new-user`, a beneficiary may not have a directory record yet. Register that account through the administrator API before IT completes fulfilment. Completion links the beneficiary only if employee ID, name, branch and department match. Credentials go to the manager/head who approved the request, not automatically to its on-behalf requester.

HR police values: `Completed`, `Pending`, `Special recommendation`. References: `Both checked`, `One checked`, `Pending`. A special recommendation requires text. Final HR approval of new-user requests is blocked until every beneficiary has complete acceptable clearance.

## Query inbox

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/queries?scope=query` | Query threads addressed to the current user |
| GET | `/queries?scope=response` | Queries authored by the user, with received replies |
| GET | `/queries?scope=all` | Both; paginated |
| POST | `/requests/:id/queries` | `{version,recipientId,message}`; assigned reviewer only; message max 350 characters |
| POST | `/queries/:id/reply` | `{version,message}`; intended recipient only; once per open query |

The server validates recipients against the requester, movement employee and eligible workflow participants. Raising a query pauses approval; its recipient's response restores the review status. If an admin updates pending steps while a query is open, the query remains open and returns to the updated remaining chain. If no approvals remain, the response advances the request to Approved and creates processing drafts. An old query cannot be used to modify a completed ticket. Query/response dashboard counts count **tickets**, while inbox counts count **threads**, so these can differ.

## Fulfilment and credential delivery

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/requests/:id/email-drafts` | IT reads drafts saved after final approval, including send confirmations |
| POST | `/requests/:id/email-drafts` | IT initializes drafts for a previously approved ticket; `{}` |
| POST | `/requests/:id/email-drafts/:draftId/sent` | IT records `{confirmedSent:true,email?}` after sending a draft; `email` may contain the reviewed `to`, `cc`, `subject`, and `body` |
| POST | `/requests/:id/processing` | IT records `{version,reference,notes?}` after approval; reference is the real provisioning/email reference |
| POST | `/requests/:id/complete` | IT records `{version,notes,confirmedProvisioned:true,credentials:[...]}`; fresh login |
| GET | `/deliveries` | Only the current user's unread, unexpired delivery metadata |
| POST | `/deliveries/:id/consume` | `{}`; fresh login; intended recipient only; decrypts once and erases ciphertext |

Credential row: `{employeeId,systemId,username,password}`. Never put credentials into `details`, notes, query messages, submittedForm or email. The API requires credentials for provision/reset flows, rejects credentials for unrequested systems/people, and never includes them in ticket-detail/list responses.

On completion the API records the approved access changes. It does not actually connect to AD, ICBS, email, file servers or other bank systems. `confirmedProvisioned` means IT has already verified the external action. Reset requests do not grant additional access. Movement replaces transferable system grants while preserving services outside that catalogue category. System deactivation affects only selected grants; employee deactivation disables the portal account, revokes sessions and all recorded grants. Disabling admin accounts requires the admin process.

`Approved` counts as IT processing until processing is recorded. The processing endpoint moves the ticket to HO processing. After completion, the ticket closes. A delivery expires in 24 hours and can be read only once; plan a secure reissue process for lost/expired credentials.

If a ticket has group drafts, IT confirms each draft before recording processing or completion. The API records the IT confirmation. The actual send occurs in the mail client.

Every processing draft copies `shafi@combankbd.com`, `hailyalgewatte@combankbd.com`, and the request submitter's recorded email when available. The current directory email is preferred, with the submission snapshot as fallback; new employee beneficiaries and requested future mailboxes do not replace the submitter. Existing template CCs remain, with case-insensitive deduplication. Unsent draft responses include `requiredCc` and apply this rule even to previously saved drafts. Sent snapshots retain their original recipients. The server also restores required CCs when a send confirmation is recorded, regardless of client edits. Templates support 20 optional CC recipients; processing drafts allow 23 total after the three required recipients are merged. The frontend preserves required CCs when copying, opening Gmail or recording a manual send. No SQL migration is needed.

## System email templates

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/system-email-templates` | IT and Admin get templates, the system catalogue, and each service's category, eligible system IDs and variables |
| POST | `/system-email-templates` | IT and Admin create a template using `{category,name,systemIds,to,cc,subject,body}`. Use an empty `systemIds` array for a service-wide default. `to` and `cc` are arrays of addresses |
| PUT | `/system-email-templates/:id` | Update the template using the same fields plus `version` |
| DELETE | `/system-email-templates/:id` | Delete using `{version}` after any approval overrides are removed |
| PUT | `/system-email-templates/:id/workflows/:code` | Admin or Super Admin saves `{steps:[...]}` for the template group and request type; `steps:[]` restores the default |

Writes to template and workflow configuration require recent sign-in. Use `{{items}}` in the body to render only the employee and system rows assigned to the draft. Other item variables render the unique values across those rows.

## Attachments

`POST /requests/:id/attachments`: `{name,contentType,base64}`. Pending owner only. Allowed types: PDF, PNG, JPEG; 256 KiB/file, ten/request. Returns quarantined metadata.

`GET /attachments/:id`: authorized ticket participants may download only after the scanner marks the file clean. Downloads use generated safe filenames, attachment disposition and `nosniff`. The original filename is metadata only. SVG, HTML, archives and executables are unsupported.

## Dashboard, notifications, reports and administration

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/dashboard` | Live scoped totals, approval/processing queues, query/response counts |
| GET | `/notifications` | Paginated current-user notification history |
| POST | `/notifications/:id/read` | `{}`; acknowledge own notification |
| GET | `/audit` | Admin/Super Admin; paginated events with IP, actor and search/category/date filters |
| GET | `/audit/:eventId/session` | Admin/Super Admin; paginated login-to-end timeline for a selected audit event |
| POST | `/activity` | Authenticated, Origin/CSRF required; allowlisted `{page,ticketId?}` navigation event |
| PUT | `/admin/workflows/:code` | `{roles:["CITO"],expectedRoles?:[...],applyToOpenRequests?:true}`; Admin/Super Admin, fresh login; returns `{updatedRequests}` |
| POST | `/admin/mailing-groups` | `{name,email}`; Admin/Super Admin, allowed domain |
| PUT | `/admin/mailing-groups/:id/members` | `{userIds:[...]}`; Admin/Super Admin, audited |

Workflow roles are a unique, ordered list of one to five entries selected from `Manager`, `HR`, `IT`, `CITO`, and `COO`. Submitted, movement employee review, Processing, and Completed are lifecycle stages rather than configurable approver roles. `Manager` resolves to the relevant branch manager or department head and retains organization scope. HR clearance checks apply when an HR approval is configured for a new-user request. System-specific overrides remain applicable; conflicting stage orders are rejected transactionally.

`applyToOpenRequests` defaults to false in the API; Workflow studio exposes it as an explicit checkbox, initially checked. When true, Employee review, Pending, In review, and Query requests of that type receive the updated remaining approval steps. Completed approval rows, actors, remarks, timestamps and positions are preserved, even for roles removed from the new default. Already approved, processing, completed, rejected or cancelled tickets remain unchanged. Removing all remaining approvals advances a request to Approved and creates drafts; an open query waits for its reply first. Each affected request gets a new row version and a workflow-change audit event. `expectedRoles` protects against another administrator changing the same default; a mismatch returns `409 STALE_WORKFLOW`. No SQL migration is required.

Ticket detail includes ordered `workflowSteps` with `position`, `role`, `status`, organization scope and decision metadata, including Waiting rows. The frontend renders these actual steps and checks server-computed `reviewableByMe` for action buttons, including timed acting authority. Lists include current step scope, `reviewedByMe` and `deliveryForMe`; the server remains the authorization boundary. New-user credentials still go to the approved manager/head, or the explicit scope assignment (then a unique active legacy scoped manager/head) if that approval was omitted. Missing or ambiguous custody configuration blocks delivery with `409 APPROVER_REQUIRED`.

Use the paginated request collection with permitted scope/status/search for ticket reports and the user-access collection for current-access reports. There is no anonymous bulk export or unlimited `pageSize=all` endpoint. Stream multiple bounded pages into an authorized export and protect exported PII; prevent spreadsheet formula injection if later exporting CSV.

## Acting appointments and current permissions

The lookup catalog lists only services submitted by current portal forms. Retired `new-id`, `batch-access` and `branch-transfer` records stay readable, while new POST submissions using these codes return `400 REQUEST_TYPE_RETIRED`. Administrators also receive `legacyRequestTypes` with existing-record counts; only used legacy workflows appear under the explicit Older request workflows section. No request history or saved workflow is deleted.

Applying a workflow to ongoing requests preflights every pending manager/head assignment before replacing any steps. `409 WORKFLOW_ASSIGNMENTS_INCOMPLETE` includes `error.details.assignments` grouped by exact scope, with role, branch/department, affected ticket numbers and counts. The default workflow and all ticket changes roll back on failure. The UI links each scope to Approver assignments in a separate tab. A manager assigned to an `IT` lookup does not implicitly become the head of a separate `IT Department` lookup; similarly named department records offer an explicit, user-confirmed assignment suggestion.

[Roles and acting API](ROLES-AND-ACTING.md) documents the permission matrix and `GET /acting-options`, `GET /acting-candidates`, `GET /acting-assignments`, `POST /acting-assignments`, and `POST /acting-assignments/:id/end`. Appointment writes require a fresh session, Origin and CSRF. Authentication refreshes effective authority on each request, including expiry within an existing session. Migration 015/schema 12 is required.

## Errors

Department/branch assignment management is available to IT, Admin and Super Admin through `GET /approver-assignments` and `PUT /approver-assignments/:scopeId`. Writes require a fresh session and `{employeeId,version}` with the current mapping version (null for first assignment). They reconcile waiting manager steps while preserving completed approvals. See [approver assignment setup and API](APPROVER-ASSIGNMENTS.md). Session/profile responses include `canApproveRequests`; this is a UI capability, and exact ticket assignments remain authoritative.

Errors have `{error:{code,message,requestId}}`. Typical status codes:

- `400`: invalid schema, JSON, organization, role/system selection or recipient.
- `401`: invalid/expired session, invalid credentials or MFA challenge.
- `403`: role/scope, CSRF/Origin, separation-of-duties or fresh-login failure.
- `404`: missing/inaccessible object; do not infer whether another user's record exists.
- `409`: stale version, state conflict, duplicate entry or attachment quarantine.
- `413`: oversized body.
- `415`: unsupported content type.
- `429`: rate limit; honor `Retry-After` or `error.retryAfterSeconds`. The login failure quota applies to unsuccessful credential POSTs, excluding ordinary setup/session reads, successful sign-in/MFA and infrastructure errors. The overall API request cap still applies to all endpoints. Do not automatically resubmit passwords after a cooldown.
- `500`: generic error with correlation ID; internal SQL and stack traces are not returned.

## Audit session details

Migration 016/schema 13 is required. `/audit` accepts `page`, `pageSize` (max 100), `search` (max 100 characters), exact `event`, `category` (`all`, `auth`, `requests`, `approvals`, `queries`, `configuration`, `navigation`), and optional `from`/`to` dates (`YYYY-MM-DD`, inclusive Dhaka calendar dates). It returns `{items,total,page,pageSize,stats:{people,signIns}}`. Event IDs are decimal strings to preserve SQL bigint precision.

`/audit/:eventId/session?page=1&pageSize=50` returns `{session,anchor,items,total,page,pageSize,notice?}` in chronological order. `session` contains public audit ID, user snapshot, role at login, provider, start/last-seen/expiry/end timestamps, end reason, sign-in/last IP and source; it never includes bearer tokens or hashes. `session` is null for unassociated pre-authentication/system activity. Metadata is recursively redacted for secret/credential fields. Reading a timeline itself writes `audit.session_viewed`.

New sessions use exact non-credential audit identifiers. Old sessions migrated from still-retained token rows use time boundaries; older events without IDs use recorded login/logout boundaries and an explicit historical notice. Missing logout times remain unknown; inactivity timeout is a session end, not an invented logout. Durable headers and audit events survive `sessions:cleanup`. The runtime account retains append-only restrictions on AuditEvents.

`/activity` accepts only known UI page names and an optional authorized ticket UUID. Actor, session, IP and timestamp come from the server. Client navigation is labelled `client-navigation`; this is an activity record, not proof that every click or keystroke occurred. Background refreshes are not logged as user navigation. Existing business operations remain transactionally audited; failed authenticated operations log only safe route/method/status/code after rollback, without payloads or credentials.

Approval decisions retain `decision:"approve"` for a positive step decision. The server derives `decisionLabel` from the saved request steps: `Recommended` while a later approval step exists, and `Approved` for the final step. It returns `{status,decisionLabel}` and records the label/role in audit metadata. Missing or whitespace-only remarks default to that label; supplied remarks are trimmed and limited to 2000 characters. The UI shows **Recommended** to earlier reviewers and **Approve** to the last reviewer, including an acting reviewer, with a request-summary/optional-remarks confirmation dialog. No role rank or client flag can bypass remaining steps.

## Organization management

Admin settings exposes branch/department/designation listing, detail view, creation and editing to Admin and Super Admin. `GET /admin/organizations` includes active/inactive names and assigned head/manager; `GET /admin/organizations/:id` includes linked-record counts. These reads require administrator authorization. Creation (`POST /lookups`, `{kind,name}`) and editing (`PATCH /lookups/:id`, `{kind,name,active,expectedName,expectedActive}`) additionally require a fresh session, Origin and CSRF.

Names are normalized and duplicate names within a kind are rejected. An edit keeps the GUID and kind unchanged, so foreign keys, approver assignments and acting scopes remain attached. Stale edits return `STALE_ORGANIZATION`. Ordinary deactivation is blocked when referenced; reviewed administrative deletion uses separate endpoints described in [Reviewed deletion](REVIEWED-DELETION.md), requiring migration 017/schema 14. Automatic merging is not offered. Renames audit both names transactionally. Shared current names refresh in employee profiles, directories and request headings; submitted snapshots and audit history remain historical. Original head-office/Gulshan routing identity is resolved from the first recorded previous name, so display renames do not reclassify approvals or credential custody.

Session discovery: `GET /api/auth/session` returns HTTP 200 `{authenticated:false}` when no session is present or it has expired. Valid cookie sessions return `{authenticated:true,user,csrfToken,provider}` after server verification. Provider-disabled sessions and server failures remain errors. Responses are not cached. This exception applies only to discovery; protected APIs continue returning 401 for unauthenticated requests.

Session timing is included in successful sign-in and discovery responses as `session:{serverNow,idleExpiresAt,absoluteExpiresAt,expiresAt,idleTimeoutSeconds,warningSeconds}`. `expiresAt` is the earlier idle/absolute deadline. `GET /api/auth/status` checks timing without renewing inactivity. Background GET requests do not extend sessions; restoring a valid session on browser reload does. CSRF tokens remain stable within a session, including across tabs.

The default total and idle windows are 30 minutes (`SESSION_MAX_MINUTES=30`, `SESSION_IDLE_MINUTES=30`). The minute-based total setting takes precedence over the legacy hour setting and caps existing longer sessions. Deletion review/execution requires an Admin or Super Admin session with at least 10 minutes remaining; it no longer uses the generic 10-minute sign-in-age rule. Expired windows return 401; insufficient remaining time returns 403 `REAUTHENTICATION_REQUIRED` with the explicit threshold message.

`POST /api/auth/continue` accepts `{reason:"continue"}` for the warning dialog or `{reason:"activity"}` for a throttled heartbeat after actual browser interaction. Both require a valid cookie, Origin and CSRF. Explicit continuation records `auth.session_continued`. The topbar countdown warns 60 seconds before expiry and offers **Yes, continue**. Renewal resets the idle window but preserves the original sign-in and absolute limit. Expired/revoked sessions and sessions at their absolute limit require sign-in again; the client shows a modal instead of redirecting automatically. No schema migration is needed for these timing endpoints.
