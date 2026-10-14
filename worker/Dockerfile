# syntax=docker/dockerfile:1
# Worker Lambda handlers on the AWS Lambda Node.js 22 base image, arm64 (tech design 3.2).
# Build from the repository root on arm64, so the npm workspaces resolve:
#   docker buildx build --platform linux/arm64 --file worker/Dockerfile .
# Each function picks its handler with the image command, for example generate.handler.

FROM node:22-bookworm-slim AS build
WORKDIR /repo

# Every workspace manifest is needed for npm ci to accept the root lockfile.
COPY package.json package-lock.json ./
COPY app/package.json app/
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY worker/package.json worker/
COPY infra/package.json infra/
COPY e2e/package.json e2e/
RUN npm ci --workspace=@pictora/worker --workspace=@pictora/core --workspace=@pictora/providers --include-workspace-root

COPY tsconfig.base.json ./
COPY packages packages
COPY worker worker
RUN npm run build --workspace=@pictora/core --workspace=@pictora/providers \
  && npm run build --workspace=@pictora/worker

# The bundles hold everything but sharp, which has a native binary: install the locked version for
# linux-arm64 (this stage runs on arm64) on its own, so the image carries only what the handlers load.
RUN mkdir -p /task \
  && cp worker/dist/lambda/* /task/ \
  && SHARP_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/sharp'].version")" \
  && cd /task \
  && printf '{"private":true,"type":"module"}\n' > package.json \
  && npm install --omit=dev --no-audit --no-fund --no-package-lock "sharp@${SHARP_VERSION}" \
  && node -e "import('sharp').then((m) => console.log('sharp', m.default.versions))"

FROM public.ecr.aws/lambda/nodejs:22
ENV NODE_ENV=production \
  NODE_OPTIONS=--enable-source-maps
COPY --from=build /task/ ${LAMBDA_TASK_ROOT}/
CMD ["generate.handler"]
