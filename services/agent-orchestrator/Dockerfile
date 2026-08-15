# Keep this tag aligned with the resolved Playwright version in pnpm-lock.yaml.
# The deployment pipeline scans this base and publishes the resulting image by digest.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
WORKDIR /workspace
ENV CI=true
ENV COREPACK_HOME=/opt/corepack
RUN mkdir -p "$COREPACK_HOME" && corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY --chown=pwuser:pwuser . .
RUN pnpm install --frozen-lockfile
USER pwuser
ENV HOME=/tmp
ENV TMPDIR=/tmp
EXPOSE 4005 4010
CMD ["pnpm", "--filter", "@straitsx/agent-orchestrator", "start"]
