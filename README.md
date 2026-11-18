# CBC UIDMS backend

A modular Node.js/Express API for the existing React portal, using Microsoft SQL Server. The frontend has **not** been connected or modified as part of this backend task.

Start with the SSMS steps below. Further documentation:

- [API and frontend integration](docs/API.md)
- [Frontend data mapping and workflow rules](docs/DATA-MODEL.md)
- [Security controls, deployment and VAPT checklist](docs/SECURITY.md)
- [Verification and SQL integration tests](docs/TESTING.md)

## Requirements

- A maintained Node.js LTS release, version 24 or newer, and npm.
- SQL Server **2019 or newer**, preferably SQL Server 2022+, with SQL Server Management Studio. SSMS is a client; you also need a running **Database Engine** instance.
- A TCP connection to the instance. This driver uses TCP with an explicit port, not Windows shared memory. The instructions below use SQL authentication; Windows/Entra integrated authentication would require a separately configured driver/deployment.
- A DBA account for installing the schema and a separate restricted SQL login for the running API.

## 1. Prepare the SQL Server connection

1. Open SSMS and connect to your intended SQL Server instance using your DBA/Windows account. In Object Explorer check the connected instance name; multiple instances may exist on this computer.
2. In **SQL Server Configuration Manager**, open SQL Server Network Configuration → Protocols for your instance → enable **TCP/IP**.
3. In TCP/IP Properties → IP Addresses → IPAll, configure a fixed TCP port, such as `1433`, and clear TCP Dynamic Ports. If another instance already uses 1433, choose a different unused port. Restart the appropriate SQL Server service.
4. For the SQL-login instructions below, enable **SQL Server and Windows Authentication mode** under SSMS server Properties → Security, then restart the instance if changed. Do not enable or use `sa` for the application.
5. For production, install a trusted SQL Server TLS certificate matching `DB_SERVER`. Restrict firewall access to the API host; do not expose SQL Server to public networks.

## 2. Install the database in SSMS

Open each file from this backend's `sql` folder in SSMS. Review it, then execute in this order:

| Order | File | Purpose |
| --- | --- | --- |
| 1 | [001-create-database.sql](sql/001-create-database.sql) | Creates `CBC_UIDMS` if it does not exist and enables read-committed snapshot isolation. |
| 2 | [002-schema.sql](sql/002-schema.sql) | Installs the complete schema and indexes in one transaction. Refuses to rerun against an installed schema. |
| 3 | [003-reference-data.sql](sql/003-reference-data.sql) | Adds portal roles, branches, departments, designations, systems, system roles, request types and default workflows. Can be rerun. |
| 4 | [004-runtime-permissions.sql](sql/004-runtime-permissions.sql) | Creates `uidms_api` and grants the restricted runtime role. **Replace its example password first.** |
| 5 | [005-reset-unlock-workflow.sql](sql/005-reset-unlock-workflow.sql) | Updates the reset/unlock template to CITO-only approval. Required for existing installations; safe on fresh installs. |
| 6 | [006-request-display-names.sql](sql/006-request-display-names.sql) | Renames reset to Unlock / Reset and movement to Branch / Department Transfer, preserving type codes and history. |
| 7 | [007-separate-drive-requests.sql](sql/007-separate-drive-requests.sql) | Names I Drive / S Drive Access and N Drive Access separately, and adds the S Drive system. |

The scripts use database name `CBC_UIDMS`. If you change that name, update the `USE`/database references consistently in **all four SQL files**, and change `DB_NAME` in your environment.

These scripts do not import demo employees, browser passwords, mock requests or mock access grants. Seeded organization names and workflows should be reviewed against your bank's actual policy before live use. `003` preserves existing workflow definitions and does not silently replace them on a rerun. It refreshes the seed systems' `TransferManaged` categorization; do not rerun it to manage live catalogue customizations without reviewing that effect.

`004` refuses to run with its placeholder password. Set the `@Password` declaration to a unique password of at least 24 characters, paste it only into a local uncommitted execution copy, and keep it in your secret manager. If `uidms_api` already exists, this script **does not reset its existing password**. The login has password policy and expiration enabled; schedule rotation so expiration does not stop the API.

The application login must not be `sysadmin`, `db_owner`, or the migration/DBA account. The API never automatically creates, drops or migrates your database on startup.

## 3. Configure and install the API

In PowerShell:

```powershell
Set-Location C:\Users\Administrator\Desktop\CBC_UIDMS\backend
npm.cmd ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Edit `.env`:

```dotenv
DB_SERVER=localhost
DB_PORT=1433
DB_NAME=CBC_UIDMS
DB_USER=uidms_api
DB_PASSWORD=your_actual_unique_runtime_login_password
DATA_ENCRYPTION_KEY=the_base64_key_generated_above
```

Use your server hostname and actual TCP port. For a named instance, use its hostname plus fixed port rather than `HOST\INSTANCE`. Keep `DB_ENCRYPT=true`.

For local development with SQL Server's self-signed certificate, `.env.example` sets `DB_TRUST_CERTIFICATE=true` and `COOKIE_SECURE=false`. Production refuses those settings: it requires validated SQL TLS, HTTPS origins, secure cookies and MFA.

The encryption key encrypts MFA secrets and short-lived credential deliveries with AES-256-GCM. Back it up separately from the database and restrict it to the service account. A lost key makes those encrypted values unreadable. Do not generate a new key each time the service restarts.

Check the connection and privilege boundary:

```powershell
npm.cmd run db:check
```

Expected: database `CBC_UIDMS`, schema version `4` after script 007 (`1` for the base schema), nonzero systems/request types, `IsDbOwner=0`, `IsSysadmin=0`, and no update/delete permission on audit events.

## 4. Create the first administrator

No default administrator password is embedded in SQL or source. Bootstrap is allowed only before the first Super Admin exists.

Use a secure prompt so the passphrase is not written into PowerShell history:

```powershell
$env:BOOTSTRAP_EMPLOYEE_ID = 'YOUR_EMPLOYEE_ID'
$env:BOOTSTRAP_NAME = 'Your Full Name'
$env:BOOTSTRAP_EMAIL = 'your.name@combankbd.com'
$taskSecret = Read-Host 'Initial admin passphrase (15+ characters)' -AsSecureString
$taskCredential = New-Object System.Management.Automation.PSCredential('bootstrap', $taskSecret)
$env:BOOTSTRAP_PASSWORD = $taskCredential.GetNetworkCredential().Password
try { npm.cmd run admin:bootstrap }
finally {
    Remove-Item Env:BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
    Remove-Variable taskCredential,taskSecret -ErrorAction SilentlyContinue
}
```

This creates only the portal administrator. It does not grant business-system access. On first sign-in, enroll the account in an authenticator app using the MFA API. See the [authentication walkthrough](docs/API.md#authentication-walkthrough).

After signing in, create the IT, HR, manager/head, CITO, COO and employee directory accounts through `POST /api/users`. User creation returns a one-time, 24-hour activation token: deliver it using your approved secure process. Activation sets the user's own password and starts MFA enrollment. Do not send activation tokens or passwords in ordinary logs or ticket comments.

## 5. Run

```powershell
npm.cmd run check
npm.cmd test
npm.cmd start
```

The development API listens at `http://127.0.0.1:4000`. Liveness is available at `GET /health/live`. Database readiness is checked during startup; a successful liveness response does not replace database monitoring.

For Postman/HTTP testing, include `Origin: http://localhost:5173` and `Content-Type: application/json` on writes. Authenticated writes also need the session cookie and `X-CSRF-Token`. Origin enforcement applies to non-browser clients too. Do not disable it to make a test client work.

For local frontend integration later, use matching hostnames consistently: `localhost` frontend → `localhost` API, or `127.0.0.1` frontend → `127.0.0.1` API. Cookies use `SameSite=Strict`; unrelated cross-site frontend/API domains are intentionally unsupported. Production should serve the API under the same site, preferably `/api` through a reverse proxy.

## 6. Background tasks

Schedule these under a restricted service account. The API does not automatically start them:

```powershell
# Every few minutes: expire sessions, challenges, counters and delivery ciphertext.
npm.cmd run sessions:cleanup

# Optional: after configuring a trusted SMTP relay, process notification outbox.
npm.cmd run mail:worker

# Optional: after installing ClamAV and configuring CLAMSCAN_PATH.
npm.cmd run attachments:scan
```

Attachments are quarantined and cannot be downloaded until a successful malware scan. The API accepts PDF, PNG and JPEG documents up to **256 KiB each**, with a maximum of ten per request. No scanner or scanner failure means files remain quarantined. Keep scanner signatures updated. MIME/signature checks alone do not establish that a file is safe.

The mail worker uses SMTP TLS with certificate validation, exact configured recipient domains, text-only notifications, and no credential contents. It sends at least once: a crash between SMTP acceptance and the DB update can produce duplicate notification mail. Monitor retry failures in `EmailOutbox`. Provisioning AD, email and other bank systems is **not** automated by this API; IT must provision through approved systems and then confirm completion.

## Structure

```text
backend/
  sql/                  Standalone SSMS installation scripts
  src/
    app.js              HTTP middleware and route composition
    server.js           Database startup, HTTP timeouts and shutdown
    config.js           Validated environment configuration
    core/               SQL binding, validation, encryption, errors, rate limiting
    modules/
      auth/             Passwords, MFA, sessions, CSRF
      directory/        Users, organization catalogue, systems, signatures, access
      requests/         Submission, editing, approvals, movement and HR clearance
      queries/          Queries and recipient-authorized responses
      fulfilment/       Processing, approved access grants, encrypted deliveries
      dashboard/        Counts, notifications and audit browsing
      admin/            Workflow and mailing-group administration
      attachments/      Quarantine and authorized downloads
      audit/            Transactional audit and notification helpers
  scripts/              Bootstrap, verification, cleanup, email and scan workers
  test/                 Security/policy tests and opt-in SQL lifecycle test
  docs/                 API, data model, deployment and testing guidance
```

## Production and VAPT

The implementation includes controls intended to support an OWASP ASVS review. It is **not a VAPT certificate or a guarantee of passing**. Review [SECURITY.md](docs/SECURITY.md) before deployment. Run the SQL lifecycle test against a separate test database and perform independent testing of the deployed frontend, API, SQL permissions, network and reverse proxy before putting real employee data into it.
