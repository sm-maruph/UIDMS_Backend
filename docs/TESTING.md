# Verification

## Local checks without SQL Server

```powershell
Set-Location C:\Users\Administrator\Desktop\CBC_UIDMS\backend
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd audit
```

`check` syntax-checks source/scripts and imports the API module to catch unresolved exports. Unit and HTTP tests do not open SQL Server. They test authentication boundaries, role checks, CSRF/Origin, SQL binding, strict input, pagination, error disclosure, password hashing, encryption/context integrity, approval scope and stale versions. They intentionally do not claim to prove SQL execution or all deployment controls.

The SQL integration test is skipped in the normal suite unless explicitly enabled. Do not count a skipped integration test as a passed database test.

Mock-mode tests cover the original fixture identities and beneficiaries, loopback/development guards, production rejection, hashed-password account creation and the normal activation path. For the local data migration, all 16 imported accounts were verified against SQL-backed login, and the CITO request list (42 records), ticket detail and dashboard were verified through HTTP. The importer was rerun to verify that identical sources are skipped without duplication. These checks do not replace the opt-in full SQL lifecycle test.

## SQL syntax check using SSMS's parser

If SSMS 22 is installed in the usual location:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\validate-sql.ps1
```

For another installation, supply `-ScriptDomPath 'absolute path to Microsoft.SqlServer.TransactSql.ScriptDom.dll'`. This uses Microsoft's SQL Server 2022 parser and **never connects to SQL Server**. It checks grammar, not foreign-key semantics, actual privileges, certificates or execution plans.

## Opt-in local request submission check

For a focused request-submission regression check against an already seeded **local development** database:

```powershell
$env:UIDMS_SQL_REQUEST_SMOKE = 'true'
node --env-file=.env --test test/request-creation.sql.test.js
Remove-Item Env:UIDMS_SQL_REQUEST_SMOKE
```

This check requires local mock mode and the imported `BNGL6191` account. It exercises login, CSRF-protected request POSTs, SQL approval routing, and ticket reads for upgrade, new ID and unlock/reset requests. All table changes are rolled back, including test sessions and audit entries; SQL ticket sequence values can still advance. It does not change existing mock records. The normal test suite skips this check.

## Opt-in local profile editing check

For profile editing, the equivalent focused local mock check is:

```powershell
$env:UIDMS_SQL_PROFILE_SMOKE = 'true'
node --env-file=.env --test test/profile.sql.test.js
Remove-Item Env:UIDMS_SQL_PROFILE_SMOKE
```

It verifies designation, signature, access additions/removals, retained grant provenance and stale-version rejection through HTTP against SQL Server. All changes, including test sessions, are rolled back. It requires the local mock dataset and refuses non-development configuration.

## Hybrid authentication check with SQL

The current AD-only deployment uses this rollback-only check:

```powershell
$env:UIDMS_SQL_AD_ONLY_SMOKE = 'true'
node --env-file=.env --test test/ad-only.sql.test.js
Remove-Item Env:UIDMS_SQL_AD_ONLY_SMOKE
```

It injects a directory verifier, matches the existing Super Admin by the verified employee ID, completes MFA and checks its SQL session/role while preserving IDs, requests and grants. It verifies rejection of local login/sessions. Changes roll back; rate counters use memory to avoid post-response writes sharing the rollback connection. This does not verify real AD connectivity.

The older hybrid check below requires an unconverted mock database and applies only to testing that legacy mode:

```powershell
$env:UIDMS_SQL_HYBRID_SMOKE = 'true'
node --env-file=.env --test test/hybrid-auth.sql.test.js
Remove-Item Env:UIDMS_SQL_HYBRID_SMOKE
```

This local-development check uses an injected directory verifier, not a real AD connection. It verifies mock-to-real linking, removal of the shared password, AD MFA enrollment/verification, provider persistence on sessions and disabling an established provider. It uses the seeded `MOCK001` profile and rolls back all changes. It is skipped during the ordinary suite. Actual directory connectivity is separately checked with `npm run ad:check -- --account YOUR_AD_LOGON_NAME` after configuration.

## Full SQL lifecycle in a disposable database

Use a **new disposable empty database**, never your real `CBC_UIDMS`. The test refuses names not starting `CBC_UIDMS_TEST_`, refuses a production environment and refuses a database containing user tables. It does not drop/truncate a database or tables.

1. In SSMS, as a test DBA, create a database such as `CBC_UIDMS_TEST_20261117`. Create a **dedicated test-only login/user** with `db_owner` in that database for the schema-installing test. Do not give this elevated test identity to the API in production.
2. Copy `.env.example` to `.env.integration`. This file is gitignored.
3. Set the actual server/port, test database and test login credentials, generate a separate encryption key, and set:

   ```dotenv
   NODE_ENV=test
   DB_NAME=CBC_UIDMS_TEST_20261117
   UIDMS_SQL_INTEGRATION=true
   COOKIE_SECURE=false
   ALLOWED_ORIGINS=http://localhost:5173
   ```

4. Run:

   ```powershell
   npm.cmd run test:sql
   ```

The test installs `002`/`003` into that named empty database, creates synthetic accounts, then uses the HTTP API for submission, query, recipient reply, manager/IT/CITO/COO approval, completion, access inventory and single-use credential delivery. It verifies an unauthorized recipient cannot consume the delivery, and the audit table rejects modification.

The fixture uses test-mode password login without MFA to exercise the business lifecycle. This is a test-only configuration; also exercise real MFA, secure cookies and TLS in staging. Runtime permission validation is separate because the schema-installing test login is deliberately elevated in its disposable database.

The database is left behind for inspection whether the test passes or fails. A DBA can remove it using its exact reviewed name after inspection. To rerun, create another **empty** test database. Remove the test login when done. Never grant production runtime `db_owner` to make a failing test pass.

## Staging deployment checks

1. Install production schema using a separate migration identity.
2. Configure the restricted runtime login with `004`, then run `db:check` using that login.
3. Bootstrap only the first administrator; enroll MFA, provision other accounts and activate them.
4. Walk every request type, HR clearance, movement, approval, query, cancellation, signature, attachment and delivery path as both valid and invalid actors.
5. Run the VAPT cases in [SECURITY.md](SECURITY.md) against HTTPS, reverse proxy and real SQL certificates.
6. Test bank-specific provisioning, backups/restores, key custody and monitoring.

Dependency advisories change. Re-run the online audit for each release; a clean result is time-bound and is not equivalent to source review or penetration testing.

## Verified AD employee self-enrollment

After installing migration 013, run this rollback-only test against the local development database:

```powershell
$env:UIDMS_SQL_ENROLLMENT_SMOKE='true'
node --env-file=.env --test test/ad-enrollment.sql.test.js
Remove-Item Env:UIDMS_SQL_ENROLLMENT_SMOKE
```

It injects a directory verifier without real AD passwords and verifies new-user enrollment, optional email for multiple employees, hashed/expired/single-use tokens, rejection of role/employee-ID overrides, active organization validation, duplicate email rejection, actual TOTP verification, notification delivery without email, and denial of administrator actions. All fixture users, sessions, identities and audit records are rolled back. The normal test suite includes proof-validation and request-schema tests.

The browser flow was checked with isolated API fixtures: AD login to the existing progress wizard, Back navigation, required organization fields, optional email, recovery from a save error, QR/MFA, and the User dashboard on desktop and mobile. The browser fixtures never contacted live AD or wrote to the database.

`test/mfa-pause.test.js` verifies the explicit development pause for an already enrolled AD profile, preserved role and encrypted secret, safe cookie/session output, rejection of invalid AD credentials and locked/disabled profiles, and direct User session after new-employee profile completion. Re-enabling MFA restores the existing authenticator or first-time setup. The ordinary production configuration test also verifies that production refuses `MFA_REQUIRED=false`.

`test/client-address.test.js` verifies IIS IP:port normalization, preservation of bare IPv6 addresses and IPv6 subnet quotas, rejection of malformed addresses from a trusted proxy, and rejection of forwarded-IP spoofing from untrusted clients. Actual API and authentication middleware tests rotate source ports and confirm the same client still reaches its original rate limit while a different IP retains an independent quota.

`test/email-recipients.test.js` checks required processing CCs for new-user, template and general drafts, directory/snapshot requester email resolution, missing-email handling, deduplication, the 23-recipient bound, existing unsent drafts, preserved sent history, HTTP send-confirmation enforcement, role restrictions and header-injection rejection. Frontend recipient tests cover template/fallback drafts and saved new-user email drafts. A component interaction check also verified that editing CC cannot remove required recipients from copied text, the Gmail compose URL or the sent-confirmation payload, using stubs without opening or sending external email.

## Configurable and ongoing workflows

`test/workflows.test.js` checks flexible role order, strict role validation, preserved approval records, pending-step replacement, query return status, stale/concurrent saves, conflicting template overrides, fresh administrator authorization and manager-only new-user credential custody. Frontend workflow tests cover actual SQL step rendering/mapping, current waiting assignments, organization scope and separation of duties. Component checks exercised the real editor's role selection/save payload and the actual approval journey during CITO-only approval, HO processing and completion.

Run the rollback-only SQL test on the local development database:

```powershell
$env:UIDMS_SQL_WORKFLOW_SMOKE='true'
node --env-file=.env --test test/workflows.sql.test.js
Remove-Item Env:UIDMS_SQL_WORKFLOW_SMOKE
```

It creates isolated fixture organizations, users and a request type. It verifies configured request steps, final approval, processing emails, credential delivery and completion; applies edits to pending steps without changing an approved row; rejects stale versions and the wrong reviewer; resumes an open query into the updated chain; preserves completed tickets; supports new-requests-only edits; honors a customized reset chain; and delivers new-user credentials to the scoped manager when manager approval is omitted. All fixtures and temporary default changes roll back, and original reset/new-user workflows are verified afterward. No real AD authentication or external email send occurs.

## Organization approver assignments

`test/approver-assignments.test.js` checks IT/Super Admin restrictions, fresh sessions, strict payloads, stale mapping versions, missing/inactive accounts, exact-ID review authorization, self-approval prevention, role preservation and waiting-only reconciliation. Frontend assignment tests cover menu permission, a scoped ordinary User's approval badge/list, actual step precedence and server-authorized query recipients. Browser checks exercise finding an unknown/valid system ID, confirming and saving both scope types, refreshed assignee display, and light/dark layouts at desktop, tablet and mobile sizes.

After applying migration 014, run `test/approver-assignments.sql.test.js` with `UIDMS_SQL_APPROVER_SMOKE=true` and the local development `.env`. It verifies branch and department routing to exact IDs, multiple scopes per employee, unchanged account roles, visibility, pending-step reassignment, preserved decisions, stale version rejection and credential-safe query participant data. All fixtures roll back. See [setup and test command](APPROVER-ASSIGNMENTS.md).


## Timed acting authority and administrator boundaries

See [roles and acting appointments](ROLES-AND-ACTING.md) for the current verified role matrix, deployment migration 015, API and rollback-only SQL test. Acting authority is time-bound, evaluated on each API request, restricted to the responsible principal/scope and cannot be delegated again. Admin manages ordinary roles including IT/CITO, but only Super Admin grants new administrator authority; Admin may maintain existing administrator accounts. Direct self-access editing is restricted to IT/Admin/Super Admin, including effective acting IT; mock accounts have no exception. The SQL test verifies authority expiring inside an existing AD-backed session, scope/role replacement, actual acting approver attribution and preserved decisions.
