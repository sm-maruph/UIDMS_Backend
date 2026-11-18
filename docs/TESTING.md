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

## SQL syntax check using SSMS's parser

If SSMS 22 is installed in the usual location:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\validate-sql.ps1
```

For another installation, supply `-ScriptDomPath 'absolute path to Microsoft.SqlServer.TransactSql.ScriptDom.dll'`. This uses Microsoft's SQL Server 2022 parser and **never connects to SQL Server**. It checks grammar, not foreign-key semantics, actual privileges, certificates or execution plans.

## Opt-in SQL lifecycle test

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
