# Container health contract

The application image owns its Docker `HEALTHCHECK`, including its command and
retry timings. Production Compose inherits it. This keeps health probes versioned
with the routes and runtime tools they check, instead of leaving an older host
probe active after an application release.

- `Dockerfile`: `http://127.0.0.1:3000/api/health (existing image check)`.

Probes are bounded, unauthenticated loopback requests with no business-data writes.
Static sites use a dedicated `/healthz` response. API probes keep the service's
existing health semantics; they do not query a voting or other business endpoint.
Deployment acceptance still checks real pages, assets, revision and application
behavior before deploy-core acknowledges the release. Receiver and database
container probes remain separate.

## Herman rollout

1. Merge and publish an attested main image containing the image health check.
2. Inspect that exact image's `Config.Healthcheck` and verify its probe under the
   production user, read-only filesystem, networks and resource limits.
3. Take the app's existing `state/deploy.lock`, retain a protected copy of its host
   Compose file, and remove only the application service's `healthcheck` override.
   Keep credentials, mounts, networking and all unrelated service settings intact.
   Validate Compose without printing its resolved environment.
4. Release the lock, then redeploy the attested digest through deploy-core. Require
   Docker health, full acceptance and matching public revision/host acknowledgement.
5. Keep a compatible previous image and the saved Compose file. If the previous
   image has no embedded check, restore its saved host probe before rolling back;
   do not treat a container with no health check as verified healthy.

Do not copy a repository Compose file wholesale over Herman's maintained file.
Image publication alone does not remove an existing host override. Stage the new
image check before removing that override; do not recreate the old image with its
only check removed. No deploy-core release or shared service restart is needed
for the image changes. Use the deploy-core health audit to check host adoption.
