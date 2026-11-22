# Security and deployment review

This project implements security controls; it does not certify a VAPT pass. The reference baseline is [OWASP ASVS 5.x](https://owasp.org/www-project-application-security-verification-standard/), supported by the [OWASP API Security Top 10](https://owasp.org/API-Security/). Assess the deployed frontend and API together, including business workflows, infrastructure and operational processes.

## Implemented controls and evidence

| Concern | Implemented control | Evidence |
| --- | --- | --- |
| SQL injection | Every HTTP-derived SQL value is a typed mssql input parameter; sort/scope SQL fragments are fixed allowlists. No string-built HTTP SQL. | `core/db.js`, request/directory/query modules, search-injection HTTP test |
| Authentication | Salted scrypt hashes for real local accounts; separate explicit AD provider; no public registration; generic failed-login response; SQL account lockouts. Shared mock passwords are limited to marked local-development profiles. | `modules/auth`, crypto/hybrid tests |
| AD/LDAP | Verified StartTLS/LDAPS required outside explicit loopback development plaintext mode; fixed configured server/base, typed search filters, separate service/user binds, bounded operations, immutable GUID links, safe diagnostic categories and no automatic role assignment or local fallback | `ldap-directory.js`, `directory-link.js`, [AD setup](AD-SETUP.md) |
| MFA | TOTP with encrypted secrets, short-lived challenges, bounded attempts, replay-counter checks; production requires MFA | auth service |
| Session security | 256-bit random opaque cookie token, hashed at rest, HttpOnly, production Secure + `__Host-`, SameSite=Strict, idle/absolute expiry, login rotation, logout revocation | auth service, Sessions |
| CSRF | Session-bound synchronizer token and exact trusted Origin required for writes; JSON-only writes | app middleware, auth middleware, HTTP tests |
| CORS | Exact configured origins and credentials; no wildcard | config and app |
| Broken object authorization | Ticket, query, directory, access, attachment and delivery scope checked server-side | request policy, query and delivery modules, unauthorized-object test |
| Role/mass-assignment attacks | Current database role, strict schemas, server-generated requester/routing/status, no admin business-approval override | validators, directory routes, approval policy tests |
| Workflow bypass | Current approver and organization scope; no self-approval; HR checks; approval required before processing; immutable per-ticket workflow snapshot; self-service reset/unlock requires CITO only | request/fulfilment services |
| Concurrent updates | SQL transactions, locks and rowversion preconditions | mutation services, conflict tests |
| Sensitive data | AES-256-GCM delivery/MFA encryption; delivery recipient authorization, expiry and one-time consumption; no general credential listing | crypto and fulfilment modules |
| Resource abuse | Shared SQL-backed IP rate limits in development/production, account lockouts, bounded JSON and page sizes, query/request timeouts | SqlRateLimitStore, config, app, server |
| Login throttling | 30 unsuccessful credential submissions per 15 minutes per client IP; successful authentication/MFA and server outages do not consume this allowance. Setup/session reads and sign-outs are excluded. The overall API cap remains 180 requests/minute/IP. Blocked responses include Retry-After and JSON retry seconds; login/MFA forms show a countdown without automatic resubmission. | `core/auth-rate-limit.js`, rate-limit HTTP tests, frontend cooldown |
| Malicious uploads | Limited types and size/count, magic checks, quarantine, scanner-gated download, generated filenames and attachment disposition | attachments module and scanner worker |
| Browser defenses | Helmet, API CSP default-src none, frame-ancestors none, nosniff, no-store; no implementation header | app, HTTP header test |
| Error disclosure | Stable public errors and correlation IDs; no SQL text, stack or request body logging | error middleware, error-disclosure test |
| Audit tampering | Audit event in same transaction as business changes; SQL deny update/delete plus append-only trigger | audit service, SQL permissions/schema |
| Supply chain | Lockfile, `npm ci`, dependency audit; mail library updated after an advisory was detected during implementation | package-lock.json; rerun audit before each release |
| Mail injection/SSRF | Trusted fixed SMTP configuration; exact recipient domains, strict recipient format, text-only messages, no caller-supplied transport/raw/URL/attachment options | mail worker |

The scrypt settings are N=131072, r=8, p=1, per-user random salt and 64-byte output. These match the scrypt alternative described in the [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Account password and MFA failures have separate counters. MFA challenge attempts are also limited. Benchmark memory/CPU under realistic login concurrency: each hash requires roughly 128 MiB, and parallel hashing needs corresponding capacity.

An explicit development testing pause (`NODE_ENV=development`, `MFA_REQUIRED=false`) skips authenticator verification for existing and newly enrolled AD profiles. It preserves encrypted MFA secrets, requires successful AD verification, retains account lockouts and roles, and records the pause in startup/login audit metadata. Re-enable `MFA_REQUIRED=true` and restart to require MFA on subsequent logins. Existing sessions are not retroactively revoked. Production refuses `MFA_REQUIRED=false`.

## Production deployment

1. Put the API behind a managed HTTPS reverse proxy, bound to loopback or a private interface. Terminate TLS securely and redirect HTTP at the proxy. The API rejects non-HTTPS requests in production.
2. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, `MFA_REQUIRED=true`, `DB_ENCRYPT=true`, `DB_TRUST_CERTIFICATE=false`, and HTTPS-only `ALLOWED_ORIGINS`. Startup refuses insecure combinations.
3. Set `TRUST_PROXY` only to your proxy's explicit IP/CIDR. Never use `true` or `*`. Restrict direct network access to the API; otherwise forwarded headers can defeat TLS/IP decisions.
4. Serve frontend/API from the same site. Prefer a same-origin `/api` proxy. The existing development `Vite` server is not a production web server.
5. Keep SQL Server on a private network with a trusted certificate matching the configured hostname. Follow Microsoft's [SQL Server client security guidance](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/application-security-scenarios-sql-server?view=sql-server-ver17) for certificate validation and least privilege; this code uses the Node mssql driver's corresponding options.
6. Use the restricted runtime login. Reserve schema installation, backups and database administration for a separate DBA identity. Check effective permissions with `npm run db:check`.
7. Store secrets in your deployment secret manager. `.env` is a development convenience; restrict service-account/file ACLs. Do not commit `.env`, keys, backups, certificates with private keys or passwords. Plan encryption-key versioning and migration before rotating the data-encryption key; simply replacing the key does not re-encrypt existing values.
8. Run cleanup regularly. Define audit/request/HR retention, legal holds and deletion/anonymization policy with the bank; this project does not silently delete business/audit history.
9. Configure SQL encryption at rest/TDE where available, encrypted backups and backup-key custody. Verify restores to an isolated environment. Protect signature images, HR data and exported reports as employee PII.
10. Ship security/runtime events and SQL Server audit records to protected centralized monitoring. The built-in application audit is not independently immutable to a DBA or a compromised privileged deployment account.
11. Schedule and monitor the SMTP/scanner workers. Do not release quarantine on scanner errors. Update scanner signatures and dependencies.
12. Tune rate limits for your bank's NAT/proxy topology and expected load before go-live. Defaults are 180 API calls/minute/IP and 30 auth calls/15 minutes/IP. Production/development counters are shared in SQL; isolated unit tests use memory counters. Add gateway request-size, slow-client and upstream rate protections. Account-level lockout supplements IP limits.

## Operational gaps that require your environment/policy

- **No formal VAPT has been performed.** Unit tests and syntax checks are supporting evidence, not a penetration test.
- Runtime SQL connectivity, permissions and end-to-end workflows must be exercised against a dedicated SQL test database before deployment. The opt-in integration test is provided.
- Actual business-system provisioning is manual/external. There are no AD/LDAP, Exchange, ICBS or mail-provider provisioning connectors, and no claim that these are configured.
- The current frontend is still a mock/localStorage implementation. Before integration, remove demo role switching, browser-side trust decisions, demo password/credential storage and client-side approval authority. React text output helps with escaping, but assess all rendered HTML, links, images, file previews and export paths separately.
- Bank-specific form validation and risk limits require review: which employees can request on behalf of whom, privileged system-role approvals, forwarding domains, personal-device policy, HR evidence, approver delegation and emergency access.
- There is no SSO/enterprise identity provider, WebAuthn, self-service MFA recovery or automated email password reset. MFA reset/account recovery must use a separately approved, identity-verified administrative process. TOTP does not offer phishing resistance comparable to WebAuthn. For a banking deployment, prefer integration with your enterprise IdP and phishing-resistant MFA when required by policy.
- There is no public self-registration or a password-recovery endpoint that could bypass MFA. Establish tested break-glass procedures and maintain a second authorized Super Admin without weakening runtime controls.
- The passphrase validator checks length, repeat-character and a small illustrative set of known bad values; it is **not a comprehensive breached-password service**. Integrate your approved password blocklist/IdP policy before claiming full ASVS authentication coverage.
- API threat modeling, DAST, SAST, dependency/license review, production hardening, identity lifecycle, incident response and recovery drills remain release responsibilities.

## VAPT cases to execute in staging

- Log in as two different users and attempt to substitute ticket, query, user, attachment and credential-delivery IDs across every read/write route.
- Try a manager from another branch, head from another department, requester, movement subject, platform administrator and stale/revoked session on approval/processing/admin actions.
- Bypass UI and submit forged requester/status/role/step/clearance/subject fields, unknown properties and alternate content types.
- Exercise SQL metacharacters, encodings, duplicate query parameters, deeply nested/oversized JSON, negative/huge pagination and unknown sorting fields.
- Test MFA challenge expiry/replay/parallel attempts, account lockout, new-session revocation, idle/absolute timeout, password change, CSRF mismatch, unknown Origin and forged proxy headers.
- Race approval against rejection/query, reply against completion, request editing against review, and double credential consumption. Confirm one authorized result and consistent audit/notifications.
- Test real malware/EICAR in your approved test procedure, spoofed MIME/signatures, malformed images/PDF, large uploads and scanner failure. No quarantined file should download.
- Inspect responses, browser cache/history, referers, cookies, logs, crash output, database backups and emails for secrets/PII.
- Verify runtime SQL cannot change/delete audit events, alter schema, change role seed data, or gain DBA permissions.
- Test all provisioning/movement/deactivation paths with real integrations or approved manual evidence, then test restoration/rollback and lost-delivery recovery.

References: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html), [REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html), [File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [Express production security](https://expressjs.com/en/advanced/best-practice-security/), [node-mssql parameter/transaction documentation](https://github.com/tediousjs/node-mssql).

AD employee self-enrollment requires a server-created, 256-bit, ten-minute enrollment proof after a successful AD password bind. Only its hash is stored. The fixed employee ID and immutable identity are read from SQL; strict validation rejects role, identity and access overrides. Enrollment is serialized and single-use, assigns only User, issues no system access, and requires MFA before a session. Existing/disabled profiles cannot be overwritten. Supplied email addresses remain unique; missing addresses are NULL and receive in-app notifications without an invalid mail outbox entry. See `test/ad-enrollment.sql.test.js` for rollback-only SQL verification.
