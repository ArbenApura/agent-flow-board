# THE HOSTED RUNNER IMAGE: A BROWSER, THE RUNNER PROGRAM AND NOTHING ELSE. IT TAKES ONE RUN AND IS THROWN AWAY.
# Build from the repo root:   docker build -f packages/runner/Dockerfile -t afb-runner .
# The supervisor starts it for you (afb-runner supervise); you do not run it by hand. See docs/runners.md.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

# Only what the runner needs: its own package, the shared rules it imports, and its dependencies
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY packages/runner/package.json packages/runner/package.json
RUN yarn workspaces focus --production @afb/runner
COPY packages/runner/src packages/runner/src
COPY src/lib/shared src/lib/shared
# The server types the runner imports are erased at run time, so none of the server code is in this image

# The container runs as the browser image's own unprivileged user
USER pwuser
ENTRYPOINT ["node", "--import", "tsx", "/app/packages/runner/src/cli.ts"]
CMD ["start", "--hosted", "--once", "--max-jobs", "1"]
