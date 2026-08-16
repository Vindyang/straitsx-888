# A/B container build and runtime verification design

Date: 2026-08-16

## Scope

Build and verify local container images for the four Module A/B services: chain-gateway,
signer-service, ledger-service, and policy-service. The work uses the existing shared root
`Dockerfile`; it does not recreate the removed Compose configuration, deploy images, push to a
registry, contact AWS KMS, or perform a live signing or blockchain transaction.

The build is also a verification pass. If the current Dockerfile cannot resolve pnpm workspace
dependencies at runtime, first preserve the failing smoke-test evidence, then make the smallest
shared Dockerfile correction and repeat the full image matrix.

## Build matrix

Each image is built from the repository root with explicit entry-point and port arguments:

| Local image | `SERVICE_ENTRY` | `SERVICE_PORT` |
| --- | --- | ---: |
| `straitsx/chain-gateway:local` | `services/chain-gateway/src/main.ts` | 4004 |
| `straitsx/signer-service:local` | `services/signer-service/src/main.ts` | 4003 |
| `straitsx/ledger-service:local` | `services/ledger-service/src/index.ts` | 4001 |
| `straitsx/policy-service:local` | `services/policy-service/src/index.ts` | 4002 |

Builds use the existing frozen lockfile and one shared Dockerfile so all four images have the
same Node, pnpm, tini, workspace-install, and hardening behavior. Local image tags are retained
after verification for developer use, but are not pushed.

## Static image checks

Each built image must satisfy these checks before it is run:

- the configured runtime user is `node`;
- the expected service port is exposed;
- the HTTP `/health` healthcheck is present;
- the selected `SERVICE_ENTRY` and `PORT` values match the build matrix;
- neither `.env` nor `.env.*` is present in the final filesystem; `.env.example` may be present;
- service source and the dependencies needed by its pnpm workspace links are available.

The environment-file check inspects the created image rather than assuming `.dockerignore` is
sufficient. It does not print or mount the developer's local `.env` file.

## Runtime smoke flow

Run one temporary container per image, with a read-only root filesystem and a writable `/tmp`
tmpfs. Publish its service port only on loopback and wait for Docker's health status. A passing
smoke test requires the container to remain running and its `/health` endpoint to return a 2xx
response.

The signer container uses `SIGNER_KEY_SOURCE=local`, `ALLOW_LOCAL_KEY_SOURCE=true`, and a known
public development-only private-key test vector with its derived expected address. This prevents
the smoke test from requesting AWS credentials or calling KMS. The test does not submit signing
requests, and the key is never sourced from `.env`.

Other service configuration uses explicit non-secret local smoke values only where startup
validation requires them. Dependencies such as RPC endpoints or peer services are not exercised
unless a service's health endpoint requires them; the purpose is to prove image startup,
dependency resolution, configuration parsing, and health behavior.

## Failure handling

The first build-and-run attempt is the baseline. A build error, import error, configuration error,
or unhealthy status is captured with the relevant image and container logs.

The most likely existing defect is that pnpm places dependencies in service-local
`node_modules` directories during the dependency stage while the runtime stage copies only the
root and contracts dependency directories. If the baseline demonstrates that defect, the fix is
limited to copying the installed service workspace dependency trees into the runtime stage before
the repository source is copied. No package versions or service code are changed for that issue.

After any Dockerfile correction, all four images are rebuilt and all static and runtime checks
are repeated. A service-specific failure is diagnosed from its actual output; unrelated refactors
are outside this task.

## Cleanup and evidence

Temporary smoke containers are removed by their explicit names after verification. Local images
remain available. The Module A/B handover is updated with the image tags, commands or check
categories performed, results, and any remaining limitation. No commit is created; the final
handoff includes a suggested commit message.

## Acceptance criteria

- All four images build from the repository root with the frozen pnpm lockfile.
- All four images run as `node`, expose the intended port, and define the `/health` healthcheck.
- All four containers start with a read-only root filesystem and become healthy.
- Loopback HTTP requests to all four `/health` endpoints return a successful response.
- No local environment file is included in an image or supplied to a container.
- The signer smoke test uses only the documented public development test vector and makes no AWS
  KMS or live-signing request.
- Any observed workspace-dependency failure is recorded before a minimal Dockerfile fix, and the
  complete four-image matrix passes afterward.
- Temporary containers are removed, local images are retained, and no image is pushed.
- The handover records exact verification evidence and Git history remains unchanged by this task.
