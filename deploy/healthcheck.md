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
3. Deploy this first image through deploy-core while retaining the working host
   override. Require full acceptance. The running image must now contain an
   embedded probe before it can be the rollback target for the next release.
4. Take the app's existing `state/deploy.lock`, retain a protected copy of its host
   Compose file, and remove only the application service's `healthcheck` override.
   Keep credentials, mounts, networking and all unrelated service settings intact.
   Validate Compose without printing its resolved environment. Release the lock.
5. Deploy the next distinct attested image digest through deploy-core. It recreates
   the application with the inherited image probe and can roll back to the first
   embedded-check image. Re-requesting the same healthy digest only reruns
   acceptance; it does not recreate the container or adopt changed Compose settings.
6. Require Docker health, full acceptance and matching public revision/host
   acknowledgement. Keep a compatible previous image and the saved Compose file.
   If rolling back further to an image without an embedded check, restore its
   saved host probe first; a container with no check is not verified healthy.

Do not copy a repository Compose file wholesale over Herman's maintained file.
Image publication alone does not remove an existing host override. Stage the new
image check before removing that override; do not recreate the old image with its
only check removed. No deploy-core release or shared service restart is needed
for the image changes. Use the deploy-core health audit to check host adoption.
