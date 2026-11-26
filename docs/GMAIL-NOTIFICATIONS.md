# Automated Gmail notifications

The sender must first be authorized and the manual test email received. The
worker checks the encrypted token record's successful `testedAt` before claiming
mail. It uses the same OAuth refresh token and official sender name as the test.

## Start

In `backend/.env` set `GMAIL_NOTIFICATIONS_ENABLED=true`. Restart the API, then
run the worker. On a development PC use a separate terminal:

```cmd
cd /d C:\UIDMS\backend
npm run mail:worker -- --continuous
```

Use the actual project directory when different. For the hosted server, from
the backend directory:

```cmd
pm2 restart uidms-api --update-env
pm2 start ecosystem.config.cjs --only uidms-mail-worker
pm2 save
pm2 logs uidms-mail-worker --lines 20
```

Keep the worker running. It polls every 15 seconds and processes up to 100
messages per batch. After editing its environment restart it with
`pm2 restart uidms-mail-worker --update-env`. Ensure your existing Windows boot
startup mechanism restores both PM2 processes; `pm2 save` alone does not install
a Windows startup service. Keep the backend bound to loopback behind IIS.

The production backend needs its own configured Google client/redirect and the
encrypted sender authorization. Authorize on the production instance, or securely
deploy its private token file with the same client, sender and existing encryption
key. Do not commit or share the private file or change UIDMS's encryption key.
Once authorization/test setup is finished, `GMAIL_SETUP_ENABLED=false` closes the
setup endpoints; delivery continues with `GMAIL_NOTIFICATIONS_ENABLED=true`.

## Recipients and contents

The existing transactional notification service writes one outbox row per
recipient along with the in-system notification. New submissions/forwarded
workflow steps use the same scoped reviewer function as approval authorization:
the corresponding branch manager, department head, acting replacement or next
approval role. Employee review goes to the employee; processing goes to eligible
IT users. Queries go to the selected participant, replies go to the query author,
and requester updates include recommendation/approval/rejection and completion.
Only active profiles with an email address are queued. Delivery resolves the
recipient's current profile email and checks the request still exists.

Each HTML and plain-text email includes ticket reference, Request Type, Request
Action Type (grant/remove/reset/update), requester name and employee ID, branch,
department, event status and action message. The button links to
`MAIL_PORTAL_URL/requests/<ticket-reference>`; UIDMS login and access checks still
apply. No passwords, credentials, signature images, attachments, business
justification or query message text are included. Subject and HTML values are
sanitized. Recipients must match `MAIL_ALLOWED_DOMAINS`.

## Queue, retry and verification

No schema migration is required. New `EmailOutbox.Body` records contain a bounded
JSON summary with marker `uidms-notification-v1`. Old plain-text SMTP backlog is
excluded from Gmail sending. A message created before this upgrade will not be
emailed retrospectively. Existing SMTP mode processes only legacy text records;
do not run a separate legacy worker that ignores this filtering.

SQL leases protect each row from simultaneous workers. Sent rows are excluded.
Every message has a stable Message-ID based on its outbox ID. Google acceptance
sets `SentAt`; structured logs record `mail.gmail_accepted`, outbox ID and Google
message ID without credentials or mail content. API request operations never wait
for Google; Google/network failures cannot roll back an already committed ticket.

Explicit rate-limit rejections retry up to five attempts, with 5/30 minute delays.
Uncertain network outcomes, invalid recipients and authorization failures are held
at five attempts for review in `LastError`. An uncertain send may already have
arrived: inspect the mailbox before an administrator resets that one row's
`Attempts`/`ClaimedUntil`. Do not reset the whole queue. If a worker crashes after
Google acceptance but before recording `SentAt`, a duplicate is possible when the
lease expires; a stable Message-ID does not guarantee exactly-once Gmail delivery.

To verify, create a new request whose next assigned reviewer has a valid profile
email. Check that reviewer's inbox and the in-system notification, recommend it
and check the next approver, then raise/reply to a query and complete the request.
Monitor `pm2 logs uidms-mail-worker` and the outbox:

```sql
SELECT TOP (50) Id, CreatedAt, SentAt, Attempts, LastError, ClaimedUntil
FROM dbo.EmailOutbox
WHERE ISJSON(Body)=1
ORDER BY Id DESC;
```

Automated test coverage uses mocked Google sending; the SQL routing/lease smoke
test rolls back all fixture changes and sends no real mail. A received manual
test verifies the live connection, while real workflow delivery should be checked
after deploying and starting the worker. No new scheduled reminders are introduced
by this change; emails follow the existing notification events.
