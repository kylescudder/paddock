<img src="assets/icon.svg" width="48" height="48" alt="">

# Paddock

A calendar-aware Formula 1 artwork library for **paddock.thescudders.org**, self-hosted. Imports the existing 2025/2026 illustrations and removes the Illustrator overlay step.

- Season/weekend gallery, full-size viewer, hover/focus copy-image button, stable URLs, PNG downloads and self-contained hybrid SVG masters.
- Measured Formula1 typography, vector logo, per-venue colours, and current year/round. Normal weekends get two competitive sessions; sprint weekends get four.
- Six-hour calendar checks and **Sync now**. Stable event identities survive round changes and relocations; cancellations are archived and completed seasons freeze after their final calendar.
- **Better Auth sign-in administration.** Every protected API requires a verified Better Auth session. Only addresses in `AUTH_ALLOWED_EMAILS` can sign in, by password, email code, magic link or passkey; there is no sign-up. Any allowlisted owner can generate, change settings, inspect Emby, and run sync controls. Missing sign-in settings deny all admin access and disable scheduled inference. See [Better Auth setup](deploy/README.md#better-auth-sign-in).
- **OpenRouter image generation.** Settings discovers image models live, combining the dedicated Image API catalogue with older chat image models. No hardcoded model list or default paid model. Provider capabilities are checked before requests; unsupported parameters are omitted. Catalogue caching is one hour, with refresh and stale-cache indicators.
- Missing venue backgrounds are generated once and reused. Initially five attempts per UTC month, persisted in PostgreSQL, including failures. Allowance and model are owner settings. Existing background/session/round composition makes no inference calls.
- **Image studio.** Manual generation opens a studio for one weekend (venue and season). Fresh generations, feedback revisions (e.g. "make the car pink", sent with the selected version as the reference image) and uploads become versions in a shared draft; each image request uses one monthly attempt. The F1 logo, venue title, session label and year/round caption get colour pickers, linked across sessions by default or set per session. Nothing changes until **Use this thumbnail** applies the background and colours to every session and syncs Emby. Scheduled auto-generation still publishes directly. All versions are kept.
- Reviewed Emby episode mappings and automatic direct PNG uploads. The app updates Emby's stored artwork rather than relying on changed hosted bytes.

## Local development

Built with **TanStack Start** (React, TypeScript, Router and Query) on **Bun**, with **PostgreSQL**, **Postgres.js/Drizzle** and **Better Auth**. Requires Bun **1.4+**, Docker for a local database, and Python 3 only for optional archive reimport.

```sh
bun install
docker run -d --name paddock-db -e POSTGRES_PASSWORD=paddock -e POSTGRES_DB=paddock_dev \
  -p 127.0.0.1:55432:5432 postgres:18.6-alpine
cp .env.example .env
bun run setup
bun run db:migrate
bun run dev
```

The database schema is defined in `server/schema.ts` with Drizzle, matching the
existing PostgreSQL tables. `bun run db:generate --name=<change>` generates reviewed
SQL and snapshots in `drizzle/`; commit those with the schema and `bun.lock`.
`bun run db:check` checks migration history files. Run `bun run db:migrate` with
owner credentials before starting the app; it safely adopts a compatible existing
schema or applies generated migrations through drizzle-kit on a fresh database.
Raw SQL and Drizzle share one Postgres.js application client (max 4, idle 20s,
connect 10s); owner and deployment clients are separately bounded.
Do not use `drizzle-kit push` or bypass the wrapper for adoption. See
[deployment migration notes](deploy/README.md#drizzle-adoption-and-rollout) for
privileges, backups, compatibility checks and rollback.

Open **http://localhost:3000**. The gallery works immediately without credentials. Setup downloads matching font families from official F1 assets into ignored `data/fonts/`; production images cache them for offline startup. Fonts are rendered into vector paths and are not served as font files.

For integrations, copy `.env.example` to `.env` and supply environment values locally or on the host. Never commit `.env` or paste keys into issues/chat.

```sh
docker exec paddock-db psql -U postgres -c "CREATE DATABASE paddock_test"
bun run test      # needs the local database; uses paddock_test, never paddock_dev
bun run build
bun run start
```

Tests refuse to run against any database whose name does not end in `_test`; override the default with `TEST_DATABASE_URL`.

Standalone Docker: `docker compose -f compose.local.yaml up --build -d`. The host uses root `compose.yaml` with its existing platform network and an attested immutable image.

## Sign-in and OpenRouter

Set `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (at least 32 random characters) and `AUTH_ALLOWED_EMAILS` server-side; production also needs `BREVO_API_KEY` and `AUTH_EMAIL_FROM` for sign-in codes and links. The app trusts every allowlisted signed-in user as an administrator, so list only owner addresses. See [Better Auth setup](deploy/README.md#better-auth-sign-in).

Set `OPENROUTER_API_KEY`, restart the app, then sign into **Owner workspace → Settings**. Choose a live image model, supported quality/resolution, allowance, and whether to fill missing venues automatically. Saving with automation enabled queues missing active venues. Public visitors and non-owner accounts cannot reach the provider. Keys never enter the frontend build or API responses.

Discovery uses `GET /api/v1/images/models` and `GET /api/v1/models?output_modalities=image&sort=newest`. Dedicated image models use `/api/v1/images`; legacy image chat models use `/api/v1/chat/completions`. New models appear without code changes. The allowance limits **attempt count**, not a guaranteed dollar budget. OpenRouter bills usage separately. Provider failures are visible in Activity and are not silently retried with another paid model.

Original illustrations are raster, even inside Illustrator. SVG masters embed them with vector text/logo paths; PNG exports are 3840×2160. Raster backgrounds retain their original detail. Madrid and Sepang have no matching original illustration and remain pending until generated or uploaded; Sakhir's artwork is preserved for 2025, not relabelled as Sepang.

## Emby

Set `EMBY_URL` (reachable from the host) and an administrator `EMBY_API_KEY`. In **Owner workspace → Emby**, load libraries, select a category (for example **TV shows**), then choose the **Formula 1** TV show. **Inspect episodes** saves this selection and scans only that show across its seasons. Dedicated F1 libraries can use **All episodes in this library**. Suggestions infer the year, venue and session from episode titles and folder/file names, without relying on round or episode numbers. Review the suggestions, save correct mappings, then use **Update Emby now**. Ambiguous matches need an explicit choice. Both seasons are available for mapping.

Mappings use persistent event/session identities rather than round numbers. Paddock uploads base64 PNGs to Emby's Primary episode-image endpoint and remembers each rendered version. Failures stay visible and retryable; placeholders and cancelled sessions are not pushed over existing artwork. Keys remain environment-only.

## Hosting and data

See [host deployment](deploy/README.md), which covers database provisioning, Cloudflare Access, the deploy webhook and rollback. GitHub Actions publishes attested multi-platform images; the host's existing Cloudflare Access → Tunnel → Caddy pattern queues verified deployments with backups and rollback.

State lives in PostgreSQL (`paddock`, via the host's existing platform database). Generated backgrounds and cached exports live in persistent `data/`. Run one app instance: its in-process queue/scheduler owns inference and calendar checks. Later-season background overrides do not change completed seasons.

## Sources and checks

- The imported archive has 48 Illustrator files, 126 artboards and 25 original backgrounds. `assets/artwork.json` contains measured layouts, font families, official font URLs and provenance. The fonts are publicly downloadable but not openly licensed, so they are never committed.
- `python3 scripts/import-archive.py --archive ~/Archive.zip` reproduces the import with checked-in measurements. Optional `--inspect-ai` rebuilds measurements using PyMuPDF.
- `bun run test:e2e` runs the Emby selection/review/save journey in Chromium at desktop and mobile widths, including reload persistence and empty/error states. First run `bun run setup`, `bunx --no-install playwright install chromium`, and create `paddock_e2e_test` in the local PostgreSQL instance (or set `E2E_DATABASE_URL` to an isolated database ending in `_e2e_test`). The fixture resets that database, uses the real app and API handlers, and substitutes the signed-in session, Emby, and OpenRouter at their external boundaries; live integrations are not exercised. Reports and screenshots are saved in `.local/emby-selection/`.
- `bun run test` checks authorization (Better Auth, including allowlisted sign-in, single-use codes/links, email limits and redirect safety), limits, discovery, rendering, calendar reconciliation and Emby uploads with isolated test providers.
- Deploy tests cover signature/timestamp/path/queue gates, the acknowledgement endpoint, provenance rejection, backup and migration failure, failed acceptance and rollback. CI also enforces Prettier formatting (`bun run format:check`).

Primary references: [Better Auth](https://www.better-auth.com/docs), [Better Auth UI](https://better-auth-ui.com), [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), [Jolpica](https://github.com/jolpica/jolpica-f1/blob/main/docs/endpoints/races.md), [Emby](https://dev.emby.media/reference/RestAPI/ImageService/postItemsByIdImagesByType.html).
