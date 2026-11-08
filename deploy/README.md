# Paddock on the host

## Shared deployment service

This app is registered as `paddock` in the central deployment registry
`/Users/kyle/platform/deploy-core/apps.json`. LaunchAgent
`com.kylescudder.deploy-core` runs the single installed engine. Installed application hooks ship in deploy-core at `app_hooks/paddock/hooks.py`
(`installed_hooks: true`); this repo’s `deploy/hooks.py` is the reference command
contract. The receiver, credentials, queues,
state and database contracts below remain app-specific. Manual deployment uses
`./deploy/host-deploy.sh sha256:<digest>`.

Engine updates, application registration, failure inspection and service rollback
are documented in [deploy-core](https://github.com/kylescudder/deploy-core).
There are no vendored engine files, lock files or sync PRs. Do not install an
app-specific LaunchAgent. Apply future engine changes once through the central service.


Public site: **https://paddock.thescudders.org**. Deploy hook:
**https://deploy-paddock.thescudders.org/hooks/paddock**.

This follows the current Thursday Office Tracker deployment on the host: GitHub-hosted AMD64/ARM64 builds, an immutable GHCR digest and provenance attestation, Cloudflare Access Service Auth, the existing Tunnel/Caddy `platform-web` network, a restricted queue receiver, and `com.kylescudder.deploy-core` running as Colima's owner. It does not install a self-hosted Actions runner or give the receiver a Docker socket.

## Deployer

Application-specific behavior is packaged in the immutable deploy-core service
release. The authoritative source is
[`app_hooks/paddock/hooks.py`](https://github.com/kylescudder/deploy-core/blob/main/app_hooks/paddock/hooks.py),
with its source provenance in `config/tooling-sources.json`. The installed copy is
`/Users/kyle/platform/deploy-core/current/app_hooks/paddock/hooks.py`. Updating
this app’s reference `deploy/hooks.py` alone does not change the installed hook.

## Host setup

Run on **the host**, from a reviewed checkout. Forge currently cannot authenticate to the host over SSH; the app and release tooling can be prepared there, but hostname/Access registration needs the existing the host credentials.

```sh
mkdir -p /Users/kyle/platform/apps
git clone git@github.com:kylescudder/paddock.git /Users/kyle/platform/apps/paddock
cd /Users/kyle/platform/apps/paddock
python3 -B deploy/bootstrap-host.py <host LocalHostName>
```

The bootstrap is resumable. It creates private directories and a signing secret, sends that secret to the repository's `production` environment through stdin, starts the receiver, and prepares the receiver; register the app centrally. It preserves existing private files. It creates `.env` with blank integration credentials; copy the approved Clerk, OpenRouter, and Emby configuration from the host's existing secret store when permissions are ready. Until the Clerk keys are set, every admin endpoint is denied and no automatic inference runs. The public gallery works without integration keys.

## Cloudflare

Use the host's existing platform tooling and Cloudflare permissions. Before exposing the hook, create a **dedicated** Access application covering all of `deploy-paddock.thescudders.org`, with one **Service Auth** policy allowing only a new service token named `github-paddock-deploy`. Store its returned client ID/secret in protected files and pipe them to GitHub `production` secrets named `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Record the application/token resource IDs and expiry in `state/cloudflare-resources.json`, matching the Office Tracker convention. Do not print secret values. Do not add an Access login wall to the public artwork hostname.

After that policy exists, register only the exact webhook path:

```sh
cd /Users/kyle/platform
python3 scripts/hostname.py add paddock-deploy deploy-paddock.thescudders.org --upstream paddock-deploy-hook:9000 --path /hooks/paddock --dry-run
python3 scripts/hostname.py add paddock-deploy deploy-paddock.thescudders.org --upstream paddock-deploy-hook:9000 --path /hooks/paddock
python3 scripts/hostname.py add paddock paddock.thescudders.org --upstream paddock:3000 --dry-run
python3 scripts/hostname.py add paddock paddock.thescudders.org --upstream paddock:3000
```

The helper owns DNS, Tunnel ingress and Caddy registration. Inspect its dry-run output and preserve unrelated routes. Reuse the existing platform tunnel; no per-app tunnel token is needed.

## First deploy and CI/CD

Every push to `main` runs Release. CI checks the app and deploy tooling, builds/publishes both architectures, attests the multi-platform digest, then moves the `main` tag. The first release can publish while the webhook is being provisioned: `DEPLOY_ENABLED=false` prevents an unconfigured production request.

For this user-owned private repository, the official `@actions/attest` toolkit signs with GitHub's private Sigstore instance and `skipWrite: true`, then stores the bundle in GHCR with `@sigstore/oci`. GitHub's repository attestation storage requires Enterprise for private repositories. Both Release and the host verify the registry bundle using `gh attestation verify --bundle-from-oci`; no extra signing key or public transparency-log disclosure is needed. See the [toolkit storage documentation](https://github.com/actions/toolkit/tree/main/packages/attest#storage).

Once the receiver/Access routes and three production secrets exist:

```sh
gh variable set PADDOCK_BASE_URL --body https://paddock.thescudders.org --repo kylescudder/paddock
gh variable set DEPLOY_ENABLED --body true --repo kylescudder/paddock
gh workflow run Release --ref main --repo kylescudder/paddock
```

Release checks that Access blocks anonymous callers, unrelated hook paths return 404, and invalid HMAC signatures are rejected by the receiver. It then queues the exact digest and waits for two things: the host's acknowledgement (an authenticated `GET` of the hook, returning `status: deployed` with the exact revision and image) and the public `X-Paddock-Revision` header equalling that commit. The host verifies the repository, workflow, `refs/heads/main`, GitHub-hosted runner provenance, and requested revision independently before pulling.

After starting a candidate, the host runs `deploy/verify.ts` inside it. The read-only checks cover the restricted runtime database role, seeded calendar data, the frontend and fingerprinted assets, health revision and cache headers, the public library, PNG thumbnails with ETag/304, sandboxed SVG masters, 404s, and that owner APIs and generation refuse anonymous callers. Only after they pass does the host write `state/public/deployment.json`, which the receiver exposes (revision and image only). A failed check restores the previous image and leaves the earlier acknowledgement in place, so CI cannot report an early green release. Recreate the receiver (`docker compose -f deploy/compose.deploy-hook.yaml --env-file .env.deploy-hook up -d`) after pulling this change so it mounts `state/public`.

The private repository's GHCR package must be readable by the host's existing registry credentials. No private registry credential is sent to GitHub by the deployer.

## Data, backups and rollback

State is in the `paddock` PostgreSQL database on the host's existing `platform-db` network; `data/` holds only generated backgrounds, the disposable render cache and fonts. Provision it like Office Tracker: `python3 /Users/kyle/platform/scripts/provision-project.py paddock`, which creates the `paddock_owner` (migrations) and `paddock_runtime` (restricted app) roles and protected `projects/paddock/{owner,runtime}-password` files. Only `runtime-password` is mounted into the app. `compose.yaml` joins `platform-web` and `platform-db`, with no host ports. Run a single app instance: the in-process queue/scheduler owns inference and six-hour calendar checks. Runtime limits are 1 GiB and 2 CPUs to support 4K rendering.

After verifying an image and before replacing the app, the deployer saves a private `pg_dump` (latest 14 retained), then runs `server/migrate.ts` in a one-shot container with the owner credential. A failed backup or migration leaves the current app running. Failed health restores the previous image; migrations are not reversed, so schema changes must stay additive and compatible with the previous runtime. Register `paddock` for the host's weekly encrypted database backups. Include `data/`, protected `.env*`, `secrets/`, and deployment state in the host's established encrypted NAS backup. Render cache in `data/renders` is disposable. Original backgrounds are versioned in Git.

```sh
cd /Users/kyle/platform/apps/paddock
docker compose --env-file .env ps
launchctl print gui/501/com.kylescudder.deploy-core
tail -n 100 state/deploy.log
./deploy/host-deploy.sh sha256:<previous-attested-main-digest>
```

Host `deploy/` and Compose changes require updating the reviewed host checkout and recreating the receiver when relevant; routine app releases run only the independently verified image. Pause releases with `gh variable set DEPLOY_ENABLED --body false --repo kylescudder/paddock`.

## Database connection budget

The runtime role is limited to eight PostgreSQL connections. Application work
uses at most four, health checks at most one, and deployment verification or
database CLI work at most one. Sequential deployment commands use their own
one-connection client instead of importing the application pool. This leaves
two slots for operator connections during a release; owner migrations use a
separate role. Paddock's current HTTP health check uses no database connection.

CI exercises the real deployment client against an eight-connection test role,
with all four application slots held open. Concurrent deployment queries must
share one backend, health must still connect, two spare slots must remain usable,
and a ninth connection must be rejected by PostgreSQL.

## Drizzle adoption and rollout

This follows the existing house pattern: TypeScript Drizzle tables, committed
`drizzle/` SQL/snapshots, `db:generate` and owner-only `db:migrate`, and a separate
`drizzle.__drizzle_migrations` journal (as in Thursday Office Tracker and Wedding
Picture Uploader). Application, owner wrapper and deployment clients all use
Postgres.js (`postgres`); Drizzle's `postgres-js` adapter shares the application
client for state reads/writes. Existing tagged/unsafe SQL stays in place. Bun runs
installs, scripts, builds, generation and migration commands. Drizzle-kit is a
production dependency because the existing owner one-shot uses the runtime image.

The lazy application client is shared even by simultaneous first callers, with
`max: 4`, `idle_timeout: 20` and `connect_timeout: 10` (seconds). The separate
owner wrapper and deployment clients each use `max: 1` with the same timeouts.
Drizzle-kit uses its own Postgres.js client capped at one connection. The reserved
owner session holds its advisory lock across validation and the kit subprocess;
validation uses explicit BEGIN/COMMIT/ROLLBACK on that session. Store transactions
share the pool's Drizzle codecs and use Postgres.js transactions/savepoints, so
raw queries and state writes commit or roll back together. JSONB object/string
representations from the previous Bun client remain readable; timestamp outputs
remain ISO strings. State writes retain Bun's JSONB string containing serialized
JSON, so the previous image's scalar decoder can still read them on rollback.
No schema/data conversion is needed for the driver change.

`server/migrate.ts` remains the deployment/local entrypoint. It takes the existing
`DATABASE_URL` and `DATABASE_PASSWORD_FILE`, reserves one owner connection for a
session advisory lock and validation, and runs `drizzle-kit migrate` through Bun
with a separate one-connection owner client. Allow **two owner connections** for
this command; it consumes no runtime slots. Do not overlap manual owner commands
with a release. The four-slot application pool and eight-slot runtime role budget
are unchanged. Two simultaneous wrapper commands would need a third owner slot
just to wait for the lock while the active wrapper runs kit; with a two-slot owner
limit, one may safely fail and require retry. Keep the existing host serialization.
Pool limits apply per process: do not overlap full old/new app pools under an
eight-slot runtime role or increase role limits to hide an overlap.

On a fresh database, the wrapper restricts the journal schema then drizzle-kit
applies `0000_baseline.sql`. On a legacy database with no journal entries, the
wrapper compares public tables with a disposable reference schema built from that
frozen baseline inside a transaction. It checks table kind/persistence, columns,
types, nullability/defaults, keys, indexes (including descending/null ordering),
RLS, triggers and rules. The reference schema is removed before commit; no
application rows are read or changed, and initial DDL is never rerun on live tables.
An exact match records only the baseline hash/timestamp; partial or incompatible
schemas abort without recording adoption. Investigate any mismatch rather than
forcing a baseline or editing an applied migration. Existing history must match
the release’s committed migration prefix. Repeated runs are safe.

The journal schema, tables and sequences are restricted to the owner: PUBLIC and
the existing `<database>_runtime` role receive no access, even with broad default
table grants. Keep owner credentials out of the app. The migration does not alter
application grants or create roles/databases; host provisioning remains responsible
for the existing owner/runtime separation and public-table default privileges.

Before the first release:

1. Review the generated baseline and adoption tests, and confirm the installed
   deploy-core Paddock hook still uses the command below. No hook change is needed
   for this PR: read-only filesystem, user `501:20`, 128 MiB, 0.5 CPU, owner secret
   mount, 120-second timeout, and backup-before-migrate all remain the same.
2. Verify the existing owner has at least two available connections and the
   runtime role has no inherited owner privileges. Preserve the private backup
   gate and current image until owner migration completes.
3. Rehearse on a protected restore of the existing database, then release through
   the normal attested-image workflow. Local verification here uses synthetic
   data only; no production restore or host change was performed.

The coordinated host command remains:

```sh
# Run by the installed hook, after backup, with the existing owner secret mount:
# --entrypoint bun <candidate-image> /app/server/migrate.ts
```

Rollback restores the prior attested image through deploy-core. This PR changes no
application tables or data; the previous Bun SQL runtime and handwritten additive
migration remain compatible and ignore the private Drizzle journal. Leave the
journal in place on rollback. A failed validation/migration leaves the current app
running; do not drop application tables or restore a database just to undo this
foundation. Future migrations must remain additive and compatible with the prior
image. Do not run an older Drizzle release’s migrator against a newer migration
history: the prefix check deliberately refuses unknown history.

## Better Auth rollout and Clerk rollback

`AUTH_PROVIDER` selects exactly one sign-in provider for both the server and the
rendered client. It defaults to `clerk`, so this additive release can be deployed
before the owner sign-in changes. Changing it requires recreating the app
container; do not try to hot-swap its process environment. With `clerk`, the
owner workspace, Clerk's sign-in and account menu are unchanged, and every
`/api/auth/*` path returns 404.

The owner migration `0001_better_auth` adds `auth_user`, `auth_session`,
`auth_account`, `auth_verification`, `auth_passkey`, `auth_rate_limit` and
`auth_email_limit`. It does not alter or rewrite any existing table. Paddock keeps
no per-user data (every signed-in owner administers the same library), so there
are no Clerk user IDs to link: access is the email allowlist itself. Runtime CRUD
on the new tables uses the existing `paddock_runtime` role through the host's
public-table default privileges and the existing four-connection pool.

Prepare these settings in the host's protected `.env`, retaining the Clerk keys:

```dotenv
AUTH_PROVIDER=clerk
BETTER_AUTH_URL=https://paddock.thescudders.org
BETTER_AUTH_SECRET=<stable, cryptographically random app-specific secret>
AUTH_ALLOWED_EMAILS=<comma-separated owner emails>
BREVO_API_KEY=<Paddock transactional API key>
AUTH_EMAIL_FROM=paddock@thescudders.org
AUTH_EMAIL_DAILY_LIMIT=40
```

These are required only when `better-auth` is selected; a missing or invalid
value is reported by name (never value) and keeps the owner workspace closed.
In production `BETTER_AUTH_URL` must be `https://`, and the passkey RP ID is its
exact hostname. Generate a secret of at least 32 characters and keep it stable
across releases. Keep it and the sending API key out of Git, image layers and CI.
Use a sender address on a domain verified in Brevo.

Access model: there is no sign-up. Only addresses in `AUTH_ALLOWED_EMAILS`
(trimmed, lowercased) can get an account, which is created the first time they
sign in by email code or magic link. Every protected API also requires that the
session's email is verified and still on the list, so removing an address revokes
existing sessions on the next request. Each owner proves email ownership again;
Clerk identities are not imported.

Cutover:

1. Deploy the image through the normal attested release with `AUTH_PROVIDER=clerk`
   (or unset). The owner migration adds the auth tables; the existing acceptance
   checks run as before.
2. Add the settings above to the protected `.env`.
3. Set `AUTH_PROVIDER=better-auth` and recreate only the `web` service with the
   same image (`docker compose --env-file .env up -d --no-deps web`).
4. Check the public gallery, signed-out `/admin` (redirects to `/auth/sign-in`),
   email-code sign-in, the owner workspace, Profile → Set password → reset link
   → password sign-in, and passkey enrollment and sign-in on a real device.

Rollback: set `AUTH_PROVIDER=clerk` and recreate only the `web` service with the
same image. Keep the Clerk keys, its production instance and DNS available until
Better Auth has been in use for a while. The retained previous image is another
rollback option. Leave the additive auth tables in place; never restore an older
database just to change providers.

Sign-in lives at `/auth/<view>` with four methods that link to each other:
password (`/auth/sign-in`, the default), email code (`/auth/email-otp`), magic link
(`/auth/magic-link`) and passkey. Forgot/reset password use `/auth/forgot-password`
and `/auth/reset-password`; `/auth/sign-up` redirects to sign-in. They use the
official Better Auth UI shadcn components restyled to Paddock's dark palette and
red accent; the public gallery does not load them. Every method opens `/admin`,
or a same-site `?redirectTo=` path such as `/profile`. Signed-in owners get an
avatar menu with Profile and Sign out; sign-out returns to the gallery.

`/profile` has a profile photo, a display name, optional first/last names, the
read-only verified email, password (a "Set password" reset link when none exists,
then change password) and passkeys. `/api/auth/update-user` accepts name fields
and, for `image`, only the value the photo endpoint already stored; it requires a
verified allowlisted session and the exact app `Origin`.

Profile photos: migration `0002_profile` adds `user_profile` (one row per
`auth_user`, removed with it). `GET`/`PUT`/`DELETE /api/profile/avatar` act only
on the signed-in owner's own photo and need a verified, still-allowlisted email
(and the exact `Origin` for changes); with Clerk selected the path is a 404.
Uploads are JPEG, PNG or WebP up to 2 MiB, checked by signature, decoded by
`sharp` (already in the image for gallery uploads) with a pixel bound, resized to
a 256 px square and re-encoded as JPEG, which drops EXIF/GPS and other metadata.
The photo is stored as `bytea` in Paddock's own Postgres, so the existing
encrypted project backups cover it; nothing is written to `data/`. Responses are
`no-store`, `nosniff` and same-origin only, and each upload gets a new version in
its URL. The runtime role reaches the table through the same default privileges
as the auth tables.

Emails: six-digit codes (ten minutes, five attempts, stored as a keyed HMAC),
magic links (ten minutes, single use, stored hashed) and reset links (30 minutes,
single use; a reset revokes existing sessions). Passwords are 12–128 characters.
Mail is only sent to allowlisted addresses; any other address gets the same
generic success response. Persistent limits in `auth_email_limit`: one email per
recipient per minute, five per hour, and an app-wide `AUTH_EMAIL_DAILY_LIMIT`
(default 40 per rolling 24 hours, failures included). Per-IP limits use
Cloudflare's `CF-Connecting-IP`. Mail goes through Brevo's HTTP API with an 8 s
timeout; responses, codes, links and keys are never logged. Emails use the
Paddock logo at `/email-logo.png` (PNG, because Gmail does not show SVG).

Redirect safety: `callbackURL`, `newUserCallbackURL`, `errorCallbackURL` and reset
`redirectTo` must resolve to this origin; control characters, backslashes, and
paths that normalise to `//host` are refused. The client's `?redirectTo=` handling
applies the same rule. The app's `/api/auth/$` route forwards only the endpoints
this UI uses (session, sign-out, profile update, email code, password, magic link,
password reset/change, list accounts and passkeys) and returns 404 for the rest,
including `sign-up/email`.

Email codes are the most reliable method on phones (magic links open wherever
the mail app opens links). The email-code form keeps only the pending email and
request time in tab-scoped storage for ten minutes so a mobile reload does not
send another email; it never stores the code. Brevo's free plan adds a
`List-Unsubscribe` header to transactional mail, which some clients show as a
mailing-list banner.
