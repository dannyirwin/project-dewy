# KMS API — multi-stage build.
# The database stack is NOT in this image: `supabase start` runs its own
# Docker containers, and LM Studio runs on the host. This image is just the
# Node service; docker-compose wires it to both via host.docker.internal.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.json --noEmit \
 && pnpm prune --prod

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY src ./src
COPY tsconfig.json ./
# tsx runs the TS sources directly (same as `pnpm start`); no emit step needed.
RUN pnpm add -g tsx@4
EXPOSE 3000
USER node
CMD ["tsx", "src/api/server.ts"]
