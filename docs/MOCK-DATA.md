# Local mock data and login

The current deployment uses **AD-only sign-in**. Mock records remain as business/test data, but their local password hashes and demo flags were removed; `1234` no longer works. See [current AD setup](AD-SETUP.md). Instructions below describe historical fixture setup for a separate installation explicitly configured for local mock login.

The current frontend fixture files have been imported into `CBC_UIDMS`. SQL Server now holds the user directory, access grants, requests, beneficiaries, approval steps, HR checks, queries and replies. The frontend loads these records through the API. Original fixture payloads are retained in `DemoImports` and request details so form-specific fields and historical remarks are preserved.

The initial import contains 16 accounts: the 9 original mock users, 6 additional beneficiary profiles referenced by requests, and the extra `MOCK001` account. It also contains 42 requests, 23 query recipient entries, 13 replies and 56 access grants. Multi-recipient mock queries become separate recipient entries.

## Sign in

Use the employee ID and password **1234** for every imported mock account.

| Employee ID | Name | Role |
| --- | --- | --- |
| BD06653 | S.M. Shahriar Rahman Maruph | Super Admin |
| BD00387 | Noor Mohammad Shafi Kamal | CITO |
| BD02072 | Haily Algawatte | COO |
| BD06619 | Shah Mohammad Al Noor | IT |
| BD00438 | Sabin Rahman | HR |
| BNGL6191 | Md. Rabbi Ali Khan | User |
| BNGL0315 | Abu Jami | Branch manager |
| BD00411 | Mojammel Haque | User |
| BD00351 | Asem Chowdhury | Branch manager |
| MOCK001 | Mock Test User | User |

The additional beneficiary IDs are `BD07881`, `DEMO3`, `DEMO8`, `DEMO18`, `DEMOQUERY3` and `DEMOQUERY7`.

After changing `.env`, restart `npm run dev` in the backend and refresh the frontend. The local login screen lists available mock accounts. Business-ticket visibility follows each account's role: Super Admin manages platform configuration; CITO/IT/HR/COO can review operational data. A platform administrator does not automatically receive operational ticket visibility.

## Add another mock account

Sign in as `BD06653`, open **Admin settings → Organization setup**, and create a user with **Mock account (password 1234)** selected. Fill in its unique employee ID, email, name, role, branch and department, then save. The account is stored in SQL Server and can sign in immediately with its ID and `1234`. Ordinary accounts created with this checkbox cleared use the existing activation flow.

Use the pencil beside your name in the sidebar to open **Edit profile**. You can change designation, add or remove current system/role assignments, and upload a PNG e-signature. These changes save together to SQL Server. Unchanged grants retain their original IDs, dates and request provenance; removed assignments are revoked rather than deleted. Direct access editing is restricted to IT, Admin and Super Admin, regardless of mock status. Other accounts use approved requests for access changes. Portal role, employee ID, branch and department cannot be changed through this editor.

## Import on another development installation

1. Execute SQL scripts through `016-session-audit.sql` in SSMS. Current API schema version is 13; script 011 supplies mock-data support.
2. In the backend `.env`, use `NODE_ENV=development`, `HOST=127.0.0.1`, a local `DB_SERVER`, and `MOCK_LOGIN_ENABLED=true`.
3. From the backend folder, run:

```powershell
npm.cmd run db:seed-mock
npm.cmd run db:seed-mock -- --apply
```

The first command previews. The second imports in one transaction. Identical previously imported sources are skipped; existing unrelated employee IDs, emails or ticket numbers are never overwritten. Changed source fixtures require an explicit follow-up migration instead of replacing edited database records. No import runs automatically at API startup.

The importer reads the committed fixture modules; unsaved browser data is not part of those modules. The legacy request `UID-2026-1002` specifies only "Multiple systems" with no selected systems or people. Its original metadata and query/approval history are preserved, but no specific system selections are invented. Complete that missing selection before using it to test provisioning. The source has no completed fulfilment records or uploaded attachment files to migrate.

## Development boundary and future AD integration

Passwords are stored as separately salted scrypt hashes. Shared-password login and the MFA exception apply only to accounts marked `IsDemo=1`, with explicit development mode and a loopback client/server. Real accounts retain normal authentication and MFA. Production startup refuses mock mode; turning mock mode off also prevents existing demo sessions from accessing APIs. This is a local test facility, not a production/VAPT authentication configuration.

For the current hybrid AD setup, follow [AD-SETUP.md](AD-SETUP.md). Local mock profiles can coexist with explicitly linked genuine AD profiles during development. Converting an individual mock profile requires `ad:link --convert-mock`, which removes its shared local password and mock exceptions while preserving its business records. For production, disable `MOCK_LOGIN_ENABLED` and remove or deliberately convert remaining demo profiles. Changing an environment flag alone does not link identities.
