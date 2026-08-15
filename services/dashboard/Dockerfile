FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /workspace
ENV CI=true
ENV COREPACK_HOME=/opt/corepack
RUN mkdir -p "$COREPACK_HOME" && corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile --filter @straitsx/dashboard...
RUN pnpm --filter @straitsx/dashboard build
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@straitsx/dashboard", "start"]
