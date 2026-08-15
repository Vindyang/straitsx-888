# Keep this tag aligned with the resolved Playwright version in pnpm-lock.yaml.
# The deployment pipeline scans this base and publishes the resulting image by digest.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
WORKDIR /workspace
ENV CI=true
ENV COREPACK_HOME=/opt/corepack
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
    && apt-get purge -y \
      gstreamer1.0-libav \
      libavcodec60 \
      libavfilter9 \
      libavformat60 \
      libavutil58 \
      libcjson1 \
      libgstreamer-plugins-bad1.0-0 \
      libmbedcrypto7t64 \
      libopenexr-3-1-30 \
      libpostproc57 \
      libswresample4 \
      libswscale7 \
      libzvbi-common \
      libzvbi0t64 \
      gstreamer1.0-plugins-bad \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p "$COREPACK_HOME" && corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY --chown=pwuser:pwuser . .
RUN pnpm install --frozen-lockfile
COPY services/agent-orchestrator/docker-entrypoint.sh /usr/local/bin/module-c-entrypoint
RUN chmod 0755 /usr/local/bin/module-c-entrypoint
ENV HOME=/tmp
ENV TMPDIR=/tmp
ENV TSX_DISABLE_CACHE=1
EXPOSE 4005 4010
ENTRYPOINT ["/usr/local/bin/module-c-entrypoint"]
CMD ["pnpm", "--filter", "@straitsx/agent-orchestrator", "start"]
