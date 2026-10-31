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
Picture Uploader). Paddock retains its Bun SQL pool and existing queries; Drizzle’s
Bun SQL adapter wraps that same pool for state reads/writes. The extra Postgres.js
driver is used only by drizzle-kit, never by the application. Drizzle-kit is a
production dependency because the existing owner one-shot uses the runtime image.

`server/migrate.ts` remains the deployment/local entrypoint. It takes the existing
`DATABASE_URL` and `DATABASE_PASSWORD_FILE`, reserves one owner connection for a
session advisory lock and validation, and runs `drizzle-kit migrate` through Bun
with a separate one-connection owner client. Allow **two owner connections** for
this command; it consumes no runtime slots. Do not overlap manual owner commands
with a release. The four-slot application pool and eight-slot runtime role budget
are unchanged.

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
