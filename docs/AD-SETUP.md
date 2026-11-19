# AD-only sign-in

The current deployment accepts **Active Directory login only**. Local/mock sign-in is disabled. Existing SQL user records determine the UIDMS role, organization, designation and system access.

## Existing accounts

The backend verifies the AD account and password, then uses the employee ID **returned by AD** (`sAMAccountName` by default) to find the existing active `dbo.Users.EmployeeId`. It preserves that row's role and access. There is no separate manual linking step for the first successful matching login. It pins the immutable AD identity in `DirectoryIdentities`; conflicting later identities require administrator review. Existing MFA requirements still apply before a session is issued.

The current database contains `BD06653` with role **Super Admin**. AD must verify that same employee ID. `BFD06653` is a different ID and is not treated as an alias. IDs are never renamed automatically. Roles are never assigned from an ID prefix, a login-form field, or an AD group.

An authenticated AD identity absent from `dbo.Users` starts first-time profile setup. The existing progress wizard collects full name, department, branch, and optional work email. The employee ID comes only from AD and cannot be edited. Completion creates a profile with the fixed **User** role and no access grants, then requires authenticator enrollment and a valid code before issuing a session. Existing users keep their assigned roles and access. Disabled/locked profiles cannot enroll a replacement account.

Apply [migration 013](../sql/013-ad-self-enrollment.sql) as a DBA before starting this version of the API. It advances the schema to version 10, allows multiple users without email, preserves uniqueness of supplied addresses, and adds temporary enrollment proofs. It has already been applied to this workspace's local `CBC_UIDMS` database.

Profile setup uses a random 256-bit token kept only in browser memory; SQL stores its hash and the verified AD identity. It expires after ten minutes, is replaced by another successful AD login for that identity, and is consumed once the profile is created. Canceling setup creates no user; a profile saved before MFA can resume authenticator enrollment at the next AD login. Admins can later change User roles through **Admin settings**.

## Authenticator enrollment

After AD verifies an existing user's credentials, the first MFA setup shows **Show QR code**. Open an authenticator app, add an account, scan the QR code, and enter its six-digit code in UIDMS to complete enrollment. **Can't scan? Enter a setup key instead** opens the manual fallback.

The frontend generates the QR locally from the backend's `otpauthUrl`; no external QR service receives the secret. UIDMS stores the MFA secret encrypted and activates enrollment only after a valid code. Later sign-ins request the current authenticator code without repeating setup. No database migration or additional environment setting is needed for QR enrollment.

## Minimal environment

Keep this project's SQL, session and origin settings. The AD section needs only:

```dotenv
AUTH_MODE=ad
LDAP_HOST=dc01.example.ad
LDAP_PORT=389
LDAP_BASE_DN=DC=example,DC=ad
LDAP_USERNAME=uidms-reader@example.ad
LDAP_PASSWORD='REPLACE_WITH_ACTUAL_SERVICE_PASSWORD'
LDAP_TIMEOUT=30000
LDAP_SSL=false
LDAP_TLS=false
```

Both switches explicitly false select plain LDAP only for local development (`NODE_ENV=development`, loopback API `HOST`). For StartTLS use `LDAP_TLS=true` on port 389. For LDAPS use port 636, `LDAP_SSL=true`, `LDAP_TLS=false`. Production requires encryption. Simple-bind credentials need TLS protection in transit: [Microsoft LDAP guidance](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/ldap-signing).

The configured read account searches the directory; employees supply their own AD password at sign-in. AD passwords are never copied into SQL or logged. Enter plain host/UPN/DN values without Markdown or URL wrappers, and keep credentials in the private backend `.env` and login form.

AD enablement, account suffix, short domain prefix and stable directory namespace are inferred. Optional overrides for unusual directories are `LDAP_UPN_SUFFIX`, `LDAP_NETBIOS_DOMAIN`, `LDAP_EMPLOYEE_ID_ATTRIBUTE` and `LDAP_DIRECTORY_ID`. Keep the namespace stable after pinning identities. `LDAP_CA_FILE` and `LDAP_TLS_SERVER_NAME` are optional certificate settings; verification cannot be disabled.

The development launcher watches `.env` and JavaScript changes, ignores logs/Git changes, and prints active authentication methods/transport without credentials.

## Local credential retirement

This database has been cut over: local password hashes and demo flags were removed, local sessions/challenges revoked, and all users, IDs, roles, requests and grants retained.

For another installation, first set `AUTH_MODE=ad` and `MOCK_LOGIN_ENABLED=false`, then preview and apply:

```powershell
npm.cmd run auth:ad-only
npm.cmd run auth:ad-only -- --apply
```

This clears local passwords. Returning to local authentication would require a separate credential-reset process. It does not delete users or change their roles/access.

## Connection checks

```powershell
npm.cmd run ad:check
npm.cmd run ad:check -- --account YOUR_AD_ACCOUNT
```

Run from the backend folder. The first checks transport, service-account bind and search base; the second also checks a user lookup. Neither checks an employee password nor alters the database. Safe diagnostics include the stage and reason without raw LDAP messages, host details or passwords.

`connection_timeout` or `connection_reset` during the service connection means the employee password has not been verified. Check server/port reachability, network/VPN routing and directory policy. The automated SQL-backed role-matching and enrollment tests use injected directory verifiers in rollback-only transactions; they do not use real employee passwords.

If an already-pinned AD object was deliberately replaced, a trusted operator can review ownership and use `npm run ad:link -- --account YOUR_AD_ACCOUNT --employee YOUR_UIDMS_ID --replace-link`. This is an exception path, not a requirement for normal first-time matching login.
