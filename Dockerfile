# THE SERVER IMAGE: THE APP BUILT FOR NODE, ITS PRODUCTION DEPENDENCIES, THE MIGRATIONS AND THE TWO OPERATOR COMMANDS (SPEC 4, ADR-003)
# Build from the repo root:   docker build -t agent-flow-board .
# It listens on port 3000. deploy/vps/compose.yaml runs it with PostgreSQL, a one shot migration step and a reverse proxy.
# The same image runs the operator commands: node cli/db.mjs migrate, node cli/server.mjs backup run, and so on.

FROM node:24-slim AS build
ENV CI=1
RUN corepack enable
WORKDIR /app
# The manifests first, so the install is cached until a dependency changes
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY packages/bridge/package.json packages/bridge/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/runner/package.json packages/runner/package.json
RUN yarn install --immutable
COPY . .
# The build checks the environment variables, so it gets placeholders. They stay in this stage and are never part of the image
RUN AFB_BASE_URL=https://build.invalid BETTER_AUTH_SECRET=build-time-placeholder-0123456789abcdef yarn run build && yarn run build:cli

FROM node:24-slim AS deps
ENV CI=1
RUN corepack enable
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY packages/bridge/package.json packages/bridge/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/runner/package.json packages/runner/package.json
# Only this app's production dependencies: no browser, no test tools
RUN yarn workspaces focus --production

FROM node:24-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
# adapter-node refuses bodies over 512K by default. The API caps a body at 101 MB itself (MAX_BODY_BYTES, a file is at most 100 MB), so the server limit sits just above it and the person gets the API's own message
ENV BODY_SIZE_LIMIT=102M
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/build ./build
COPY --from=build /app/cli ./cli
COPY src/lib/server/db/migrations ./src/lib/server/db/migrations
# The data volume starts with the owner of this folder, so the app (not root) can write attachments and backups there
RUN mkdir -p /data/files /data/backups && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "build/index.js"]
