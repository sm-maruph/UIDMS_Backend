# Gmail API: first authorization and test

Complete Google authorization and verify the first test email using this guide.
Automated ticket notification delivery is now available separately through the
persistent Gmail worker; see [Gmail notifications](GMAIL-NOTIFICATIONS.md).

## Development PC

`googleapis` is already in package.json/package-lock.json. Run `npm ci` if this
PC has not installed the updated backend dependencies. In your private
`backend/.env`, fill only the first two values; never send them in chat or commit
the file. The remaining settings have been added to this development workspace:

```env
GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET
GOOGLE_REDIRECT_URI=http://127.0.0.1:4000/auth/google/callback
GMAIL_SETUP_ENABLED=true
GMAIL_SENDER_EMAIL=itbangladesh@combankbd.com
GMAIL_SENDER_NAME="User ID Management System (UIDMS), Bangladesh"
GMAIL_TEST_TO=alnoorshah@combankbd.com
MAIL_PORTAL_URL=https://uidms.combankbd.com
```

Preserve the existing DATA_ENCRYPTION_KEY. It encrypts the sender refresh token
and existing UIDMS protected data; generating another key will break decryption.

1. Restart the backend (`npm run dev` locally, or restart its existing PM2 process)
   and run the updated frontend. Do not start a second backend on port 4000.
2. Sign in to UIDMS as **Super Admin**. This sender administration requires a
   sign-in within the last ten minutes. It does not change AD login for employees.
3. Open **Admin settings → Gmail API connection setup**.
4. Click **Authorize official Google account**. Google opens in the same tab; popups are not required.
5. On the Google page, sign in specifically as **itbangladesh@combankbd.com** and grant
   the requested permissions. This must be the actual Workspace mailbox account;
   a different primary account/alias is not silently accepted.
6. The callback saves the refresh token encrypted automatically. There is no
   raw-token copy/paste step and no secret is returned to the frontend.
7. Return to Admin settings and click **Refresh connection status**.
8. Check the recipient is **alnoorshah@combankbd.com**, then click
   **Send first test email** once.
9. A Google message ID means Google accepted the message. Confirm actual receipt
   in the recipient's inbox (and check Spam if necessary). Share only the success
   result/message ID or sanitized error code, never a token or client secret.
10. Set `GMAIL_SETUP_ENABLED=false` and restart the backend after setup/testing.
    This disables the authorization/callback/test endpoints. It does not delete
    the encrypted refresh token. Sender status remains Super Admin-only.

Google requests **gmail.send** plus **openid/email** identity scopes. The latter
verify that consent came from the official mailbox, without granting inbox-read
access. Ensure these basic identity scopes are allowed in the consent setup.
If the consent app is External/Testing, add itbangladesh@combankbd.com as a test
user. A Workspace administrator may need to allow this OAuth client under API
controls. For production, use the appropriate Internal app audience (when
available) or Google's production publishing/verification process. External
Testing refresh tokens with Gmail scopes expire after seven days.

The backend can remain accessed as localhost during normal UIDMS login. The
one-time setup link navigates to 127.0.0.1 before Google consent so the callback
cookie is bound to the correct host. The saved UIDMS admin session is checked
again at the start and callback. Keep that session active while authorizing.

## Token storage and permissions

The file is `backend/private/gmail-token.json`. Its payload is AES-256-GCM
encrypted, bound to the sender/client ID, and excluded from Git. No access token
or refresh token is returned by the status API. Do not put backend/private or
backend/.env under the IIS site's physical path.

On Windows, configure the dedicated `private` folder's NTFS permissions **before
authorizing on the hosted server**. Remove broad inherited access; grant Full
Control to SYSTEM/Administrators and only the required access to the account
running the API. That account needs read/write to this folder for atomic token
updates; other users and the frontend IIS app pool do not. On Unix the folder
and newly written files use 0700/0600. Back up the encrypted token and existing
DATA_ENCRYPTION_KEY securely and separately from the public frontend build.

Authorization uses ten-minute one-use state, a browser-bound HttpOnly SameSite
cookie, PKCE and an ID-token nonce. The verified Google ID token must match the
configured client audience, verified sender email and Workspace hosted domain.
Changing the OAuth client or sender requires reauthorization rather than reusing
an unrelated token. The setup flow currently assumes the existing single API
instance; restarting it invalidates in-flight setup links, which must be reopened.

## Production

Use these mail settings alongside the project's existing production TLS, SQL,
secure-cookie, MFA and trusted-proxy settings:

```env
GOOGLE_REDIRECT_URI=https://uidms.combankbd.com/auth/google/callback
MAIL_PORTAL_URL=https://uidms.combankbd.com
GMAIL_SETUP_ENABLED=false
```

The Web OAuth client must contain that exact redirect URI. Deploy the updated
IIS web.config rule forwarding `/auth/google/start`, `/auth/google/callback` and
`/auth/google/result` to Node, in addition to the existing `/api/*` proxy rule.
IIS must forward the HTTPS scheme as required by the existing production API.
Do not bypass the production HTTPS check. Configure IIS/reverse-proxy logging
to omit query strings on the OAuth endpoints so authorization codes/state are
not written into access logs. No Google tokens belong in URLs or browser storage.

Authorize separately in production by temporarily enabling setup, or securely
transfer the encrypted token only when using the same sender, OAuth client and
DATA_ENCRYPTION_KEY. Do not copy the entire development .env over production.
Restart after changing environment settings. No database migration is needed
for this connection-test stage.

## Network troubleshooting

The backend needs outbound HTTPS to accounts.google.com, oauth2.googleapis.com,
www.googleapis.com and gmail.googleapis.com, including Google's signing-key
endpoint used to verify the ID token. Browser access alone does not prove Node
can reach those endpoints. npm's proxy configuration does not configure Google
API requests. If your network requires a proxy, configure HTTPS_PROXY privately
for the Node process and NO_PROXY for localhost/127.0.0.1/::1. Encode special
characters in proxy credentials; do not log or share the proxy URL.

Trust your organization's approved CA certificates in Node if TLS interception
is used. Do not set NODE_TLS_REJECT_UNAUTHORIZED=0. Set Node startup CA options
in the actual service/process environment before Node starts.

Errors are sanitized: GMAIL_NOT_CONFIGURED, GMAIL_ACCOUNT_MISMATCH,
GMAIL_SCOPE_MISSING, GMAIL_REFRESH_TOKEN_MISSING, GMAIL_REAUTHORIZE,
GMAIL_CLIENT_INVALID, GMAIL_CONNECTION_FAILED or GMAIL_STATE_INVALID. An expired
setup/admin session requires signing in and starting authorization again.

## Delivery proof and duplicate protection

The first test starts a new Google client with **only** the stored refresh token,
so the SDK must obtain a fresh access token before sending RFC-compliant MIME
through users.messages.send. A branded HTML body and plain-text alternative use
the official sender name. No Gmail messages.read/modify scope or SMTP password
is required. Custom subjects, HTML/text and company-domain recipients are
supported by the reusable backend service.

Test attempts have a stable test ID and Message-ID, encrypted persisted attempt
state, and audit events: gmail.authorization_started/completed/failed and
gmail.test_started/accepted/failed. Repeating an accepted test ID returns its
stored result instead of sending again. A timeout or crash leaves the attempt
pending/unknown and it is not retried automatically; check the recipient mailbox
before deliberately starting a new test. Gmail does not guarantee exactly-once
delivery from a Message-ID alone. After the real first test is confirmed, enable the Gmail notification worker
as described in GMAIL-NOTIFICATIONS.md. Legacy SMTP backlog is excluded from
Gmail delivery to avoid sending historical test notifications.

Official references:
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/openid-connect/reference
- https://developers.google.com/workspace/gmail/api/guides/sending
- https://developers.google.com/identity/protocols/oauth2
- https://github.com/googleapis/google-api-nodejs-client#using-a-proxy


## Authorization-button diagnostics

Open browser DevTools ? Console and enable Preserve log. Use **Check setup
 diagnostics**, then **Authorize official Google account**. Browser entries begin
with `[UIDMS Gmail]` and identify `gmail-diag-v1`, configuration readiness,
loaded-setting booleans, request failures/status codes and same-tab navigation.
The backend terminal emits `gmail.setup.configuration`,
`gmail.setup.authorize_received`, `gmail.setup.authorize_finished` and
`gmail.setup.google_redirect`. It reports the running backend's settings, process
ID and working directory; no client secret, token, cookie or authorization link
is logged. A disabled authorization button is explained in the status diagnostics.
`older-backend` means the frontend reached an API without the new diagnostics.

## Automated request notifications

After the first test is received, follow [Gmail notification delivery](GMAIL-NOTIFICATIONS.md) to enable and run the persistent worker.
