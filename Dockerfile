# Container image for the four A/B services: ledger, policy, signer, chain-gateway.
#
#   docker build --build-arg SERVICE_ENTRY=services/signer-service/src/main.ts \
#                --build-arg SERVICE_PORT=4003 -t straitsx/signer .
#
# ONE FILE, FOUR IMAGES. The services differ only in entry point and port; the
# workspace, install and runtime are identical. Four near-identical Dockerfiles
# would drift, and the drift would be a base image or a hardening flag that
# quietly applies to three services out of four.
#
# The build context is the REPO ROOT, not a service directory. This is a pnpm
# workspace and every service depends on `@straitsx/contracts` via
# `workspace:*`, so an install scoped to one service directory cannot resolve it
# (module-c handover §5.2 records the same trap).
#
# There is no compile step, deliberately: the workspace is source-first with
# `noEmit`, services run under tsx, and nothing imports a build artefact
# (conventions.md §1). The image therefore ships source and runs it.

FROM node:22-alpine AS base

# tini reaps zombies and forwards signals, so ECS task stop actually stops the
# process rather than waiting out the timeout.
RUN apk add --no-cache tini

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# --- dependencies ---------------------------------------------------------------
# Copied before the source so a source-only change reuses this layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY services/ledger-service/package.json services/ledger-service/
COPY services/policy-service/package.json services/policy-service/
COPY services/signer-service/package.json services/signer-service/
COPY services/chain-gateway/package.json services/chain-gateway/
# --frozen-lockfile makes a stale lockfile a build failure rather than a silent
# resolution difference between the image and the machine that tested it.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

# --- runtime --------------------------------------------------------------------
FROM base AS runtime

ARG SERVICE_ENTRY
ARG SERVICE_PORT
# Fail at BUILD time rather than shipping an image that crashes on start.
RUN test -n "$SERVICE_ENTRY" || (echo "SERVICE_ENTRY build-arg is required" >&2; exit 1)
RUN test -n "$SERVICE_PORT"  || (echo "SERVICE_PORT build-arg is required"  >&2; exit 1)
ENV SERVICE_ENTRY=${SERVICE_ENTRY}
ENV PORT=${SERVICE_PORT}
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
# pnpm's isolated linker puts each service's direct dependencies (including the
# @straitsx/contracts workspace link) under that service's node_modules.
COPY --from=deps /app/services ./services
COPY . .

# Non-root. node:alpine ships uid 1000 `node`; nothing in the image needs write
# access, so the filesystem can be mounted read-only by the task definition.
USER node

EXPOSE ${SERVICE_PORT}

# /health is the one path exempt from the internal-token check
# (conventions.md §3), which is exactly why it works as a container health check
# and why A15's probe targets it.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Execute the installed binary directly. Invoking pnpm here delegates to
# Corepack, which needs a writable cache and may attempt a network download at
# container startup; neither is available in a read-only production task.
CMD ["sh", "-c", "exec ./node_modules/.bin/tsx \"$SERVICE_ENTRY\""]
