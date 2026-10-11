# syntax=docker/dockerfile:1
# Next.js standalone server on Lambda with the Lambda Web Adapter (tech design 3.1).
# Build from the repository root on arm64, so the npm workspaces resolve:
#   docker buildx build --platform linux/arm64 --file app/Dockerfile .

FROM node:25-bookworm-slim AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

# Every workspace manifest is needed for npm ci to accept the root lockfile.
COPY package.json package-lock.json ./
COPY app/package.json app/
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY worker/package.json worker/
COPY infra/package.json infra/
COPY e2e/package.json e2e/
RUN npm ci --workspace=@pictora/app --workspace=@pictora/core --workspace=@pictora/providers --include-workspace-root

COPY tsconfig.base.json ./
COPY packages packages
COPY app app
RUN npm run build --workspace=@pictora/core --workspace=@pictora/providers \
  && npm run build --workspace=@pictora/app

# The standalone output mirrors the monorepo layout, so the server lives at app/server.js. Next.js leaves
# static files and public out of it; the server falls back to them, and the deploy copies .next/static to S3.
RUN mkdir -p app/public \
  && cp -r app/.next/static app/.next/standalone/app/.next/static \
  && cp -r app/public app/.next/standalone/app/public

FROM node:25-bookworm-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter

ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  HOSTNAME=0.0.0.0 \
  AWS_LWA_PORT=3000 \
  AWS_LWA_READINESS_CHECK_PATH=/api/health \
  AWS_LWA_INVOKE_MODE=response_stream

WORKDIR /var/task
COPY --from=build --chown=node:node /repo/app/.next/standalone ./
# Lambda's file system is read-only apart from /tmp, where Next.js keeps its cache.
RUN ln -s /tmp/next-cache app/.next/cache

USER node
EXPOSE 3000
CMD ["node", "app/server.js"]
